import {
	extract_identifiers,
	extract_paths,
	is_event_attribute,
	is_text_attribute,
	object
} from '../../../../utils/ast.js';
import { binding_properties } from '../../../bindings.js';
import {
	clean_nodes,
	determine_element_namespace,
	escape_html,
	infer_namespace
} from '../../utils.js';
import {
	AttributeAliases,
	DOMBooleanAttributes,
	DOMProperties,
	PassiveEvents,
	VoidElements
} from '../../../constants.js';
import { is_custom_element_node, is_element_node } from '../../../nodes.js';
import * as b from '../../../../utils/builders.js';
import { error } from '../../../../errors.js';
import {
	function_visitor,
	get_assignment_value,
	serialize_get_binding,
	serialize_set_binding
} from '../utils.js';
import {
	EACH_INDEX_REACTIVE,
	EACH_IS_CONTROLLED,
	EACH_ITEM_REACTIVE,
	EACH_KEYED
} from '../../../../../constants.js';

/**
 * Serializes each style directive into something like `$.style(element, style_property, value)`
 * and adds it either to init or update, depending on whether or not the value or the attributes are dynamic.
 * @param {import('#compiler').StyleDirective[]} style_directives
 * @param {import('estree').Identifier} element_id
 * @param {import('../types.js').ComponentContext} context
 * @param {boolean} is_attributes_reactive
 */
function serialize_style_directives(style_directives, element_id, context, is_attributes_reactive) {
	if (style_directives.length > 0) {
		const values = style_directives.map((directive) => {
			let value =
				directive.value === true
					? serialize_get_binding({ name: directive.name, type: 'Identifier' }, context.state)
					: serialize_attribute_value(directive.value, context)[1];
			return b.stmt(
				b.call(
					'$.style',
					element_id,
					b.literal(directive.name),
					value,
					/** @type {import('estree').Expression} */ (
						directive.modifiers.includes('important') ? b.true : undefined
					)
				)
			);
		});

		if (
			is_attributes_reactive ||
			style_directives.some((directive) => directive.metadata.dynamic)
		) {
			context.state.update.push(...values.map((v) => ({ grouped: v })));
		} else {
			context.state.init.push(...values);
		}
	}
}

/**
 * Serializes each class directive into something like `$.class_toogle(element, class_name, value)`
 * and adds it either to init or update, depending on whether or not the value or the attributes are dynamic.
 * @param {import('#compiler').ClassDirective[]} class_directives
 * @param {import('estree').Identifier} element_id
 * @param {import('../types.js').ComponentContext} context
 * @param {boolean} is_attributes_reactive
 */
function serialize_class_directives(class_directives, element_id, context, is_attributes_reactive) {
	if (class_directives.length > 0) {
		const values = class_directives.map((directive) => {
			const value = /** @type {import('estree').Expression} */ (
				context.visit(directive.expression)
			);
			return b.stmt(b.call('$.class_toggle', element_id, b.literal(directive.name), value));
		});

		if (
			is_attributes_reactive ||
			class_directives.some((directive) => directive.metadata.dynamic)
		) {
			context.state.update.push(...values.map((v) => ({ grouped: v })));
		} else {
			context.state.init.push(...values);
		}
	}
}

/**
 *
 * @param {string | null} spread_id
 * @param {import('#compiler').RegularElement} node
 * @param {import('../types.js').ComponentContext} context
 * @param {import('estree').Identifier} node_id
 */
function add_select_to_spread_update(spread_id, node, context, node_id) {
	if (spread_id !== null && node.name === 'select') {
		context.state.update.push({
			grouped: b.if(
				b.binary('in', b.literal('value'), b.id(spread_id)),
				b.block([
					b.stmt(b.call('$.select_option', node_id, b.member(b.id(spread_id), b.id('value'))))
				])
			)
		});
	}
}

/**
 * @param {import('#compiler').Binding[]} references
 * @param {import('../types.js').ComponentContext} context
 */
function serialize_transitive_dependencies(references, context) {
	/** @type {Set<import('#compiler').Binding>} */
	const dependencies = new Set();

	for (const ref of references) {
		const deps = collect_transitive_dependencies(ref);
		for (const dep of deps) {
			dependencies.add(dep);
		}
	}

	return [...dependencies].map((dep) => serialize_get_binding({ ...dep.node }, context.state));
}

/**
 * @param {import('#compiler').Binding} binding
 * @param {Set<import('#compiler').Binding>} seen
 * @returns {import('#compiler').Binding[]}
 */
function collect_transitive_dependencies(binding, seen = new Set()) {
	if (binding.kind !== 'legacy_reactive') return [];

	for (const dep of binding.legacy_dependencies) {
		if (!seen.has(dep)) {
			seen.add(dep);
			for (const transitive_dep of collect_transitive_dependencies(dep, seen)) {
				seen.add(transitive_dep);
			}
		}
	}

	return [...seen];
}

/**
 * Special case: if we have a value binding on a select element, we need to set up synchronization
 * between the value binding and inner signals, for indirect updates
 * @param {import('#compiler').BindDirective} value_binding
 * @param {import('../types.js').ComponentContext} context
 */
function setup_select_synchronization(value_binding, context) {
	let bound = value_binding.expression;
	while (bound.type === 'MemberExpression') {
		bound = /** @type {import('estree').Identifier | import('estree').MemberExpression} */ (
			bound.object
		);
	}

	/** @type {string[]} */
	const names = [];

	for (const [name, refs] of context.state.scope.references) {
		if (
			refs.length > 0 &&
			// prevent infinite loop
			name !== bound.name
		) {
			names.push(name);
		}
	}

	const to_invalidate = context.state.analysis.runes
		? b.empty
		: b.stmt(
				b.call(
					'$.invalidate_inner_signals',
					b.thunk(
						b.block(
							names.map((name) => {
								const serialized = serialize_get_binding(b.id(name), context.state);
								return b.stmt(serialized);
							})
						)
					)
				)
		  );
	context.state.init.push(
		b.stmt(
			b.call(
				'$.pre_effect',
				b.thunk(
					b.block([
						b.stmt(
							/** @type {import('estree').Expression} */ (context.visit(value_binding.expression))
						),
						to_invalidate
					])
				)
			)
		)
	);
}

/**
 * Serializes element attribute assignments that contain spreads to either only
 * the init or the the init and update arrays, depending on whether or not the value is dynamic.
 * Resulting code for static looks something like this:
 * ```js
 * $.spread_attributes(element, null, [...]);
 * ```
 * Resulting code for dynamic looks something like this:
 * ```js
 * let value;
 * $.render_effect(() => {
 * 	value = $.spread_attributes(element, value, [...])
 * });
 * ```
 * Returns the id of the spread_attribute varialbe if spread is deemed reactive, `null` otherwise.
 * @param {Array<import('#compiler').Attribute | import('#compiler').SpreadAttribute>} attributes
 * @param {import('../types.js').ComponentContext} context
 * @param {import('estree').Identifier} element_id
 * @returns {string | null}
 */
function serialize_element_spread_attributes(attributes, context, element_id) {
	let is_reactive = false;

	/** @type {import('estree').Expression[]} */
	const values = [];

	for (const attribute of attributes) {
		if (attribute.type === 'Attribute') {
			const name = get_attribute_name(attribute, context.state);
			// TODO: handle contains_call_expression
			const [, value] = serialize_attribute_value(attribute.value, context);
			values.push(b.object([b.init(name, value)]));
		} else {
			values.push(/** @type {import('estree').Expression} */ (context.visit(attribute)));
		}

		is_reactive ||= attribute.metadata.dynamic;
	}

	if (is_reactive) {
		const id = context.state.scope.generate('spread_attributes');
		context.state.init.push(b.let(id, undefined));
		context.state.update.push({
			grouped: b.stmt(
				b.assignment(
					'=',
					b.id(id),
					b.call(
						'$.spread_attributes',
						element_id,
						b.id(id),
						b.array(values),
						b.literal(context.state.analysis.stylesheet.id)
					)
				)
			)
		});
		return id;
	} else {
		context.state.init.push(
			b.stmt(
				b.call(
					'$.spread_attributes',
					element_id,
					b.literal(null),
					b.array(values),
					b.literal(context.state.analysis.stylesheet.id)
				)
			)
		);
		return null;
	}
}

/**
 * Serializes dynamic element attribute assignments.
 * Returns the `true` if spread is deemed reactive.
 * @param {Array<import('#compiler').Attribute | import('#compiler').SpreadAttribute>} attributes
 * @param {import('../types.js').ComponentContext} context
 * @param {import('estree').Identifier} element_id
 * @returns {boolean}
 */
function serialize_dynamic_element_spread_attributes(attributes, context, element_id) {
	let is_reactive = false;

	/** @type {import('estree').Expression[]} */
	const values = [];

	for (const attribute of attributes) {
		if (attribute.type === 'Attribute') {
			const [, value] = serialize_attribute_value(attribute.value, context);
			values.push(b.object([b.init(attribute.name, value)]));
		} else {
			values.push(/** @type {import('estree').Expression} */ (context.visit(attribute)));
		}

		is_reactive ||= attribute.metadata.dynamic;
	}

	if (is_reactive) {
		const id = context.state.scope.generate('spread_attributes');
		context.state.init.push(b.let(id));
		context.state.update.push({
			grouped: b.stmt(
				b.assignment(
					'=',
					b.id(id),
					b.call(
						'$.spread_dynamic_element_attributes',
						element_id,
						b.id(id),
						b.array(values),
						b.literal(context.state.analysis.stylesheet.id)
					)
				)
			)
		});
		return true;
	} else {
		context.state.init.push(
			b.stmt(
				b.call(
					'$.spread_dynamic_element_attributes',
					element_id,
					b.literal(null),
					b.array(values),
					b.literal(context.state.analysis.stylesheet.id)
				)
			)
		);
		return false;
	}
}

/**
 * Serializes an assigment to an element property by adding relevant statements to either only
 * the init or the the init and update arrays, depending on whether or not the value is dynamic.
 * Resulting code for static looks something like this:
 * ```js
 * element.property = value;
 * // or
 * $.attr(element, property, value);
 * });
 * ```
 * Resulting code for dynamic looks something like this:
 * ```js
 * let value;
 * $.render_effect(() => {
 * 	if (value !== (value = 'new value')) {
 * 		element.property = value;
 * 		// or
 * 		$.attr(element, property, value);
 * 	}
 * });
 * ```
 * Returns true if attribute is deemed reactive, false otherwise.
 * @param {import('estree').Identifier} node_id
 * @param {import('#compiler').Attribute} attribute
 * @param {import('../types.js').ComponentContext} context
 * @returns {boolean}
 */
function serialize_element_attribute_update_assignment(node_id, attribute, context) {
	const state = context.state;
	const name = get_attribute_name(attribute, state);
	let [contains_call_expression, value] = serialize_attribute_value(attribute.value, context);

	// The foreign namespace doesn't have any special handling, everything goes through the attr function
	if (context.state.metadata.namespace === 'foreign') {
		const statement = { grouped: b.stmt(b.call('$.attr', node_id, b.literal(name), value)) };
		if (attribute.metadata.dynamic) {
			const id = state.scope.generate(`${node_id.name}_${name}`);
			serialize_update_assignment(state, id, undefined, value, statement, contains_call_expression);
			return true;
		} else {
			state.init.push(statement.grouped);
			return false;
		}
	}

	let grouped_value = value;

	if (name === 'autofocus') {
		state.init.push(b.stmt(b.call('$.auto_focus', node_id, value)));
		return false;
	}

	if (name === 'class') {
		grouped_value = b.call('$.to_class', value);
	}

	/**
	 * @param {import('estree').Expression} grouped
	 * @param {import('estree').Expression} [singular]
	 */
	const assign = (grouped, singular) => {
		if (name === 'class') {
			if (singular) {
				return {
					singular: b.stmt(b.call('$.class_name_effect', node_id, b.thunk(singular))),
					grouped: b.stmt(b.call('$.class_name', node_id, singular)),
					skip_condition: true
				};
			}
			return {
				grouped: b.stmt(b.call('$.class_name', node_id, value)),
				skip_condition: true
			};
		} else if (!DOMProperties.includes(name)) {
			if (singular) {
				return {
					singular: b.stmt(
						b.call(
							name.startsWith('xlink') ? '$.xlink_attr_effect' : '$.attr_effect',
							node_id,
							b.literal(name),
							b.thunk(singular)
						)
					),
					grouped: b.stmt(
						b.call(
							name.startsWith('xlink') ? '$.xlink_attr' : '$.attr',
							node_id,
							b.literal(name),
							grouped
						)
					)
				};
			}
			return {
				grouped: b.stmt(
					b.call(
						name.startsWith('xlink') ? '$.xlink_attr' : '$.attr',
						node_id,
						b.literal(name),
						grouped
					)
				)
			};
		} else {
			return { grouped: b.stmt(b.assignment('=', b.member(node_id, b.id(name)), grouped)) };
		}
	};

	if (attribute.metadata.dynamic) {
		const id = state.scope.generate(`${node_id.name}_${name}`);
		serialize_update_assignment(
			state,
			id,
			name === 'class' ? b.literal('') : undefined,
			grouped_value,
			assign(b.id(id), value),
			contains_call_expression
		);
		return true;
	} else {
		state.init.push(assign(grouped_value).grouped);
		return false;
	}
}

/**
 * Like `serialize_element_attribute_update_assignment` but without any special attribute treatment.
 * @param {import('estree').Identifier}	node_id
 * @param {import('#compiler').Attribute} attribute
 * @param {import('../types.js').ComponentContext} context
 * @returns {boolean}
 */
function serialize_custom_element_attribute_update_assignment(node_id, attribute, context) {
	const state = context.state;
	const name = attribute.name; // don't lowercase, as we set the element's property, which might be case sensitive
	let [contains_call_expression, value] = serialize_attribute_value(attribute.value, context);
	let grouped_value = value;

	/**
	 * @param {import('estree').Expression} grouped
	 * @param {import('estree').Expression} [singular]
	 */
	const assign = (grouped, singular) => {
		if (singular) {
			return {
				singular: b.stmt(
					b.call('$.set_custom_element_data_effect', node_id, b.literal(name), b.thunk(singular))
				),
				grouped: b.stmt(b.call('$.set_custom_element_data', node_id, b.literal(name), grouped))
			};
		}
		return {
			grouped: b.stmt(b.call('$.set_custom_element_data', node_id, b.literal(name), grouped))
		};
	};

	if (attribute.metadata.dynamic) {
		const id = state.scope.generate(`${node_id.name}_${name}`);
		// TODO should this use the if condition? what if someone mutates the value passed to the ce?
		serialize_update_assignment(
			state,
			id,
			undefined,
			grouped_value,
			assign(b.id(id), value),
			contains_call_expression
		);
		return true;
	} else {
		state.init.push(assign(grouped_value).grouped);
		return false;
	}
}

/**
 * Serializes an assigment to the value property of a `<select>`, `<option>` or `<input>` element
 * that needs the hidden `__value` property.
 * Returns true if attribute is deemed reactive, false otherwise.
 * @param {string} element
 * @param {import('estree').Identifier} node_id
 * @param {import('#compiler').Attribute} attribute
 * @param {import('../types.js').ComponentContext} context
 * @returns {boolean}
 */
function serialize_element_special_value_attribute(element, node_id, attribute, context) {
	const state = context.state;
	const [contains_call_expression, value] = serialize_attribute_value(attribute.value, context);

	const inner_assignment = b.assignment(
		'=',
		b.member(node_id, b.id('value')),
		b.assignment('=', b.member(node_id, b.id('__value')), value)
	);
	const is_reactive = attribute.metadata.dynamic;
	const needs_selected_call =
		element === 'option' && (is_reactive || collect_parent_each_blocks(context).length > 0);
	const needs_option_call = element === 'select' && is_reactive;
	const assigment = b.stmt(
		needs_selected_call
			? b.sequence([
					inner_assignment,
					// This ensures things stay in sync with the select binding
					// in case of updates to the option value or new values appearing
					b.call('$.selected', node_id)
			  ])
			: needs_option_call
			? // This ensures a one-way street to the DOM in case it's <select {value}>
			  // and not <select bind:value>
			  b.call('$.select_option', node_id, inner_assignment)
			: inner_assignment
	);

	if (is_reactive) {
		const id = state.scope.generate(`${node_id.name}_value`);
		serialize_update_assignment(
			state,
			id,
			undefined,
			value,
			{ grouped: assigment },
			contains_call_expression
		);
		return true;
	} else {
		state.init.push(assigment);
		return false;
	}
}

/**
 * @param {import('../types.js').ComponentClientTransformState} state
 * @param {string} id
 * @param {import('estree').Expression | undefined} init
 * @param {import('estree').Expression} value
 * @param {{
 *   grouped: import('estree').ExpressionStatement;
 *   singular?: import('estree').ExpressionStatement;
 *   skip_condition?: boolean;
 * }} assignment
 * @param {boolean} contains_call_expression
 */
function serialize_update_assignment(state, id, init, value, assignment, contains_call_expression) {
	const grouped = b.if(
		b.binary('!==', b.id(id), b.assignment('=', b.id(id), value)),
		b.block([assignment.grouped])
	);

	if (contains_call_expression && assignment.singular) {
		state.update_effects.push(assignment.singular);
	} else {
		if (assignment.skip_condition) {
			if (assignment.singular) {
				state.update.push({
					singular: assignment.singular,
					grouped: assignment.grouped
				});
			} else {
				state.update.push({
					init: b.var(id, init),
					grouped
				});
			}
		} else {
			if (assignment.singular) {
				state.update.push({
					init: b.var(id, init),
					singular: assignment.singular,
					grouped
				});
			} else {
				state.update.push({
					init: b.var(id, init),
					grouped
				});
			}
		}
	}
}

/**
 * @param {import('../types.js').ComponentContext} context
 */
function collect_parent_each_blocks(context) {
	return /** @type {import('#compiler').EachBlock[]} */ (
		context.path.filter((node) => node.type === 'EachBlock')
	);
}

/**
 * @param {import('#compiler').Attribute} attribute
 * @param {import('../types.js').ComponentClientTransformState} state
 */
function get_attribute_name(attribute, state) {
	let name = attribute.name;
	if (state.metadata.namespace !== 'foreign') {
		name = name.toLowerCase();
		if (name !== 'class' && name in AttributeAliases) {
			name = AttributeAliases[name];
		}
	}
	return name;
}

/**
 * @param {import('#compiler').Component | import('#compiler').SvelteComponent | import('#compiler').SvelteSelf} node
 * @param {string} component_name
 * @param {import('../types.js').ComponentContext} context
 * @returns {import('estree').Statement}
 */
function serialize_inline_component(node, component_name, context) {
	/** @type {Array<import('estree').Property[] | import('estree').Expression>} */
	const props_and_spreads = [];

	/** @type {import('estree').ExpressionStatement[]} */
	const default_lets = [];

	/** @type {Record<string, import('#compiler').TemplateNode[]>} */
	const children = {};

	/** @type {Record<string, import('estree').Expression[]>} */
	const events = {};

	/** @type {import('estree').Property[]} */
	const custom_css_props = [];

	/** @type {import('estree').Identifier | import('estree').MemberExpression | null} */
	let bind_this = null;

	/**
	 * @param {import('estree').Property} prop
	 */
	function push_prop(prop) {
		const current = props_and_spreads.at(-1);
		const current_is_props = Array.isArray(current);
		const props = current_is_props ? current : [];
		props.push(prop);
		if (!current_is_props) {
			props_and_spreads.push(props);
		}
	}

	for (const attribute of node.attributes) {
		if (attribute.type === 'LetDirective') {
			default_lets.push(
				/** @type {import('estree').ExpressionStatement} */ (context.visit(attribute))
			);
		} else if (attribute.type === 'OnDirective') {
			events[attribute.name] ||= [];
			let handler = serialize_event_handler(attribute, context);
			if (attribute.modifiers.includes('once')) {
				handler = b.call('$.once', handler);
			}
			events[attribute.name].push(handler);
		} else if (attribute.type === 'SpreadAttribute') {
			props_and_spreads.push(/** @type {import('estree').Expression} */ (context.visit(attribute)));
		} else if (attribute.type === 'Attribute') {
			if (attribute.name === 'slot') continue;
			if (attribute.name.startsWith('--')) {
				custom_css_props.push(
					b.init(attribute.name, serialize_attribute_value(attribute.value, context)[1])
				);
				continue;
			}

			const [, value] = serialize_attribute_value(attribute.value, context);

			if (attribute.metadata.dynamic) {
				push_prop(b.get(attribute.name, [b.return(value)]));
			} else {
				push_prop(b.init(attribute.name, value));
			}
		} else if (attribute.type === 'BindDirective') {
			if (attribute.name === 'this') {
				bind_this = attribute.expression;
			} else {
				push_prop(
					b.get(attribute.name, [
						b.return(
							b.call(
								'$.exposable',
								b.thunk(
									/** @type {import('estree').Expression} */ (context.visit(attribute.expression))
								)
							)
						)
					])
				);
				// If the binding is just a reference to a top level state variable
				// we don't need a setter as the inner component can write to the signal directly
				const binding =
					attribute.expression.type !== 'Identifier'
						? null
						: context.state.scope.get(attribute.expression.name);
				if (
					binding === null ||
					(binding.kind !== 'state' && binding.kind !== 'prop' && binding.kind !== 'rest_prop')
				) {
					const assignment = b.assignment('=', attribute.expression, b.id('$$value'));
					push_prop(
						b.set(attribute.name, [
							b.stmt(serialize_set_binding(assignment, context, () => assignment))
						])
					);
				}
			}
		}
	}

	if (Object.keys(events).length > 0) {
		const events_expression = b.object(
			Object.keys(events).map((name) =>
				b.prop(
					'init',
					b.id(name),
					events[name].length > 1 ? b.array(events[name]) : events[name][0]
				)
			)
		);
		push_prop(b.prop('init', b.id('$$events'), events_expression));
	}

	/** @type {import('estree').Statement[]} */
	const snippet_declarations = [];

	// Group children by slot
	for (const child of node.fragment.nodes) {
		if (child.type === 'SnippetBlock') {
			// the SnippetBlock visitor adds a declaration to `init`, but if it's directly
			// inside a component then we want to hoist them into a block so that they
			// can be used as props without creating conflicts
			context.visit(child, {
				...context.state,
				init: snippet_declarations
			});

			push_prop(b.prop('init', child.expression, child.expression));

			continue;
		}

		let slot_name = 'default';

		if (is_element_node(child)) {
			const attribute = /** @type {import('#compiler').Attribute | undefined} */ (
				child.attributes.find(
					(attribute) => attribute.type === 'Attribute' && attribute.name === 'slot'
				)
			);

			if (attribute !== undefined) {
				slot_name = /** @type {import('#compiler').Text[]} */ (attribute.value)[0].data;
			}
		}

		children[slot_name] = children[slot_name] || [];
		children[slot_name].push(child);
	}

	// Serialize each slot
	/** @type {import('estree').Property[]} */
	const serialized_slots = [];
	for (const slot_name of Object.keys(children)) {
		const body = create_block(node, `${node.name}_${slot_name}`, children[slot_name], context);
		if (body.length === 0) continue;

		const fn = b.arrow(
			[b.id('$$anchor'), b.id('$$slotProps')],
			b.block([...(slot_name === 'default' ? default_lets : []), ...body])
		);

		if (slot_name === 'default') {
			push_prop(b.prop('init', b.id('children'), fn));
		} else {
			serialized_slots.push(b.prop('init', b.key(slot_name), fn));
		}
	}

	if (serialized_slots.length > 0) {
		push_prop(b.prop('init', b.id('$$slots'), b.object(serialized_slots)));
	}

	const props_expression =
		props_and_spreads.length === 0 ||
		(props_and_spreads.length === 1 && Array.isArray(props_and_spreads[0]))
			? b.object(/** @type {import('estree').Property[]} */ (props_and_spreads[0]) || [])
			: b.call(
					'$.spread_props',
					b.thunk(b.array(props_and_spreads.map((p) => (Array.isArray(p) ? b.object(p) : p))))
			  );
	/** @param {import('estree').Identifier} node_id */
	let fn = (node_id) => b.call(component_name, node_id, props_expression);

	if (bind_this !== null) {
		const prev = fn;
		const assignment = b.assignment('=', bind_this, b.id('$$value'));
		fn = (node_id) =>
			b.call(
				'$.bind_this',
				prev(node_id),
				b.arrow(
					[b.id('$$value')],
					serialize_set_binding(assignment, context, () => context.visit(assignment))
				)
			);
	}

	if (Object.keys(custom_css_props).length > 0) {
		const prev = fn;
		fn = (node_id) =>
			b.call(
				'$.cssProps',
				node_id,
				// TODO would be great to do this at runtime instead. Svelte 4 also can't handle cases today
				// where it's not statically determinable whether the component is used in a svg or html context
				context.state.metadata.namespace === 'svg' ? b.false : b.true,
				b.thunk(b.object(custom_css_props)),
				b.arrow([b.id('$$node')], prev(b.id('$$node')))
			);
	}

	/** @type {import('estree').Statement} */
	let statement = b.stmt(fn(context.state.node));

	if (snippet_declarations.length > 0) {
		statement = b.block([...snippet_declarations, statement]);
	}

	return statement;
}

/**
 * Creates a new block which looks roughly like this:
 * ```js
 * // hoisted:
 * const block_name = $.template(`...`);
 *
 * // for the main block:
 * const id = $.open(block_name);
 * // init stuff and possibly render effect
 * $.close(id);
 * ```
 * Adds the hoisted parts to `context.state.hoisted` and returns the statements of the main block.
 * @param {import('#compiler').SvelteNode} parent
 * @param {string} name
 * @param {import('#compiler').SvelteNode[]} nodes
 * @param {import('../types.js').ComponentContext} context
 * @returns {import('estree').Statement[]}
 */
function create_block(parent, name, nodes, context) {
	const namespace = infer_namespace(context.state.metadata.namespace, parent, nodes, context.path);

	const { hoisted, trimmed } = clean_nodes(
		parent,
		nodes,
		context.path,
		namespace,
		context.state.preserve_whitespace,
		context.state.options.preserveComments,
		false
	);

	if (hoisted.length === 0 && trimmed.length === 0) {
		return [];
	}

	const is_single_element = trimmed.length === 1 && trimmed[0].type === 'RegularElement';
	const is_single_child_not_needing_template =
		trimmed.length === 1 &&
		(trimmed[0].type === 'SvelteFragment' || trimmed[0].type === 'TitleElement');

	const template_name = context.state.scope.root.unique(name);

	/** @type {import('estree').Statement[]} */
	const body = [];

	/** @type {import('estree').Statement | undefined} */
	let close = undefined;

	/** @type {import('estree').Identifier | undefined} */
	let id = undefined;

	/** @type {import('../types').ComponentClientTransformState} */
	const state = {
		...context.state,
		init: [],
		update: [],
		update_effects: [],
		after_update: [],
		template: [],
		metadata: {
			template_needs_import_node: false,
			namespace,
			bound_contenteditable: context.state.metadata.bound_contenteditable
		}
	};

	for (const node of hoisted) {
		context.visit(node, state);
	}

	if (is_single_element) {
		const element = /** @type {import('#compiler').RegularElement} */ (trimmed[0]);

		id = b.id(context.state.scope.generate(element.name));

		context.visit(element, {
			...state,
			node: id
		});

		const callee = namespace === 'svg' ? '$.svg_template' : '$.template';

		context.state.hoisted.push(
			b.var(template_name, b.call(callee, b.template([b.quasi(state.template.join(''), true)], [])))
		);

		body.push(
			b.var(
				id.name,
				b.call(
					'$.open',
					b.id('$$anchor'),
					b.literal(!state.metadata.template_needs_import_node),
					template_name
				)
			),
			...state.init
		);
		close = b.stmt(b.call('$.close', b.id('$$anchor'), id));
	} else if (is_single_child_not_needing_template) {
		context.visit(trimmed[0], state);
		body.push(...state.init);
	} else {
		id = b.id(context.state.scope.generate('fragment'));

		process_children(trimmed, b.call('$.child_frag', id), {
			...context,
			state
		});

		if (state.template.length > 0) {
			const callee = namespace === 'svg' ? '$.svg_template' : '$.template';

			state.hoisted.push(
				b.var(
					template_name,
					b.call(callee, b.template([b.quasi(state.template.join(''), true)], []), b.true)
				)
			);

			body.push(
				b.var(
					id.name,
					b.call(
						'$.open_frag',
						b.id('$$anchor'),
						b.literal(!state.metadata.template_needs_import_node),
						template_name
					)
				),
				...state.init
			);
			close = b.stmt(b.call('$.close_frag', b.id('$$anchor'), id));
		} else {
			body.push(...state.init);
		}
	}

	if (state.update.length > 0 || state.update_effects.length > 0) {
		/** @type {import('estree').Statement | undefined} */
		let update;

		if (state.update_effects.length > 0) {
			for (const render of state.update_effects) {
				if (!update) {
					update = render;
				}
				body.push(render);
			}
		}
		if (state.update.length > 0) {
			let render;
			if (state.update.length === 1 && state.update[0].singular) {
				render = state.update[0].singular;
			} else {
				render = b.stmt(
					b.call(
						'$.render_effect',
						b.thunk(
							b.block(
								state.update.map((n) => {
									if (n.init) {
										body.push(n.init);
									}
									return n.grouped;
								})
							)
						)
					)
				);
			}
			if (!update) {
				update = render;
			}
			body.push(render);
		}

		/** @type {import('estree').Statement} */ (update).leadingComments = [
			{
				type: 'Block',
				value: ` Update `,
				// @ts-expect-error
				has_trailing_newline: true
			}
		];
	}

	body.push(...state.after_update);

	if (close !== undefined) {
		// It's important that close is the last statement in the block, as any previous statements
		// could contain element insertions into the template, which the close statement needs to
		// know of when constructing the list of current inner elements.
		body.push(close);
	}

	if (body[0]) {
		body[0].leadingComments = [
			{
				type: 'Block',
				value: ` Init `,
				// @ts-expect-error
				has_trailing_newline: true
			}
		];
	}

	return body;
}

/**
 * Serializes the event handler function of the `on:` directive
 * @param {Pick<import('#compiler').OnDirective, 'name' | 'modifiers' | 'expression'>} node
 * @param {import('../types.js').ComponentContext} context
 */
function serialize_event_handler(node, { state, visit }) {
	if (node.expression) {
		let handler = node.expression;

		// Event handlers can be dynamic (source/store/prop/conditional etc)
		const dynamic_handler = () =>
			b.function(
				null,
				[b.rest(b.id('$$args'))],
				b.block([
					b.const('$$callback', /** @type {import('estree').Expression} */ (visit(handler))),
					b.return(
						b.call(b.member(b.id('$$callback'), b.id('apply'), false, true), b.this, b.id('$$args'))
					)
				])
			);

		if (handler.type === 'Identifier' || handler.type === 'MemberExpression') {
			const id = object(handler);
			const binding = id === null ? null : state.scope.get(id.name);
			if (
				binding !== null &&
				(binding.kind === 'state' ||
					binding.kind === 'legacy_reactive' ||
					binding.kind === 'derived' ||
					binding.kind === 'prop' ||
					binding.kind === 'store_sub')
			) {
				handler = dynamic_handler();
			} else {
				handler = /** @type {import('estree').Expression} */ (visit(handler));
			}
		} else if (handler.type === 'ConditionalExpression' || handler.type === 'LogicalExpression') {
			handler = dynamic_handler();
		} else {
			handler = /** @type {import('estree').Expression} */ (visit(handler));
		}

		if (node.modifiers.includes('stopPropagation')) {
			handler = b.call('$.stopPropagation', handler);
		}
		if (node.modifiers.includes('stopImmediatePropagation')) {
			handler = b.call('$.stopImmediatePropagation', handler);
		}
		if (node.modifiers.includes('preventDefault')) {
			handler = b.call('$.preventDefault', handler);
		}
		if (node.modifiers.includes('self')) {
			handler = b.call('$.self', handler);
		}
		if (node.modifiers.includes('trusted')) {
			handler = b.call('$.trusted', handler);
		}

		return handler;
	} else {
		// Function + .call to preserve "this" context as much as possible
		return b.function(
			null,
			[b.id('$$arg')],
			b.block([b.stmt(b.call('$.bubble_event.call', b.this, b.id('$$props'), b.id('$$arg')))])
		);
	}
}

/**
 * Serializes an event handler function of the `on:` directive or an attribute starting with `on`
 * @param {Pick<import('#compiler').OnDirective, 'name' | 'modifiers' | 'expression' | 'metadata'>} node
 * @param {import('../types.js').ComponentContext} context
 */
function serialize_event(node, context) {
	const state = context.state;

	if (node.expression) {
		let handler = serialize_event_handler(node, context);
		const event_name = node.name;
		const delegated = node.metadata.delegated;

		if (delegated !== null) {
			let delegated_assignment;

			if (!state.events.has(event_name)) {
				state.events.add(event_name);
			}
			// Hoist function if we can, otherwise we leave the function as is
			if (delegated.type === 'hoistable') {
				if (delegated.function === node.expression) {
					const func_name = context.state.scope.root.unique('on_' + event_name);
					state.hoisted.push(b.var(func_name, handler));
					handler = func_name;
				}
				if (node.modifiers.includes('once')) {
					handler = b.call('$.once', handler);
				}
				const hoistable_params = /** @type {import('estree').Expression[]} */ (
					delegated.function.metadata.hoistable_params
				);
				// When we hoist a function we assign an array with the function and all
				// hoisted closure params.
				const args = [handler, ...hoistable_params];
				delegated_assignment = b.array(args);
			} else {
				if (node.modifiers.includes('once')) {
					handler = b.call('$.once', handler);
				}
				delegated_assignment = handler;
			}

			state.after_update.push(
				b.stmt(
					b.assignment(
						'=',
						b.member(context.state.node, b.id('__' + event_name)),
						delegated_assignment
					)
				)
			);
			return;
		}

		if (node.modifiers.includes('once')) {
			handler = b.call('$.once', handler);
		}

		const args = [
			b.literal(event_name),
			context.state.node,
			handler,
			b.literal(node.modifiers.includes('capture'))
		];

		if (node.modifiers.includes('passive')) {
			args.push(b.literal(true));
		} else if (node.modifiers.includes('nonpassive')) {
			args.push(b.literal(false));
		} else if (PassiveEvents.includes(node.name)) {
			args.push(b.literal(true));
		}

		// Events need to run in order with bindings/actions
		state.after_update.push(b.stmt(b.call('$.event', ...args)));
	} else {
		state.after_update.push(
			b.stmt(
				b.call('$.event', b.literal(node.name), state.node, serialize_event_handler(node, context))
			)
		);
	}
}

/**
 * @param {import('#compiler').Attribute & { value: [import('#compiler').ExpressionTag] }} node
 * @param {import('../types').ComponentContext} context
 */
function serialize_event_attribute(node, context) {
	/** @type {string[]} */
	const modifiers = [];

	let event_name = node.name.slice(2);
	if (
		event_name.endsWith('capture') &&
		event_name !== 'ongotpointercapture' &&
		event_name !== 'onlostpointercapture'
	) {
		event_name = event_name.slice(0, -7);
		modifiers.push('capture');
	}

	serialize_event(
		{
			name: event_name,
			expression: node.value[0].expression,
			modifiers,
			metadata: node.metadata
		},
		context
	);
}

/**
 * Processes an array of template nodes, joining sibling text/expression nodes
 * (e.g. `{a} b {c}`) into a single update function. Along the way it creates
 * corresponding template node references these updates are applied to.
 * @param {import('#compiler').SvelteNode[]} nodes
 * @param {import('estree').Expression} parent
 * @param {import('../types.js').ComponentContext} context
 */
function process_children(nodes, parent, { visit, state }) {
	const within_bound_contenteditable = state.metadata.bound_contenteditable;

	/** @typedef {Array<import('#compiler').Text | import('#compiler').ExpressionTag>} Sequence */

	/** @type {Sequence} */
	let sequence = [];

	let expression = parent;

	/**
	 * @param {Sequence} sequence
	 */
	function flush_sequence(sequence) {
		if (sequence.length === 1) {
			const node = sequence[0];

			if (node.type === 'Text') {
				expression = b.call('$.sibling', expression);
				state.template.push(node.raw);
				return;
			}

			state.template.push(' ');

			const name = state.scope.generate('text');
			state.init.push(b.var(name, expression));

			const singular = b.stmt(
				b.call(
					'$.text_effect',
					b.id(name),
					b.thunk(/** @type {import('estree').Expression} */ (visit(node.expression)))
				)
			);

			if (node.metadata.contains_call_expression && !within_bound_contenteditable) {
				state.update_effects.push(singular);
			} else if (node.metadata.dynamic && !within_bound_contenteditable) {
				state.update.push({
					singular,
					grouped: b.stmt(
						b.call(
							'$.text',
							b.id(name),
							/** @type {import('estree').Expression} */ (visit(node.expression))
						)
					)
				});
			} else {
				state.init.push(
					b.stmt(
						b.assignment(
							'=',
							b.id(`${name}.nodeValue`),
							b.call(
								'$.stringify',
								/** @type {import('estree').Expression} */ (visit(node.expression))
							)
						)
					)
				);
			}

			return;
		}

		state.template.push(' ');

		const name = state.scope.generate('text');
		const contains_call_expression = sequence.some(
			(n) => n.type === 'ExpressionTag' && n.metadata.contains_call_expression
		);
		state.init.push(b.var(name, expression));
		const assignment = serialize_template_literal(sequence, visit, state)[1];
		const init = b.stmt(b.assignment('=', b.id(`${name}.nodeValue`), assignment));
		const singular = b.stmt(
			b.call(
				'$.text_effect',
				b.id(name),
				b.thunk(serialize_template_literal(sequence, visit, state)[1])
			)
		);

		if (contains_call_expression && !within_bound_contenteditable) {
			state.update_effects.push(singular);
		} else if (
			sequence.some((node) => node.type === 'ExpressionTag' && node.metadata.dynamic) &&
			!within_bound_contenteditable
		) {
			state.update.push({
				singular,
				grouped: b.stmt(b.call('$.text', b.id(name), assignment))
			});
		} else {
			state.init.push(init);
		}

		expression = b.call('$.sibling', b.id(name));
	}

	for (let i = 0; i < nodes.length; i += 1) {
		const node = nodes[i];

		if (node.type === 'Text' || node.type === 'ExpressionTag') {
			sequence.push(node);
		} else {
			if (sequence.length > 0) {
				flush_sequence(sequence);
				sequence = [];
			}

			if (
				node.type === 'SvelteHead' ||
				node.type === 'TitleElement' ||
				node.type === 'SnippetBlock'
			) {
				// These nodes do not contribute to the sibling/child tree
				// TODO what about e.g. ConstTag and all the other things that
				// get hoisted inside clean_nodes?
				visit(node, state);
			} else {
				const name = state.scope.generate(node.type === 'RegularElement' ? node.name : 'node');
				const id = b.id(name);

				// Optimization path for each blocks. If the parent isn't a fragment and it only has
				// a single child, then we can classify the block as being "controlled".
				if (
					node.type === 'EachBlock' &&
					nodes.length === 1 &&
					parent.type === 'CallExpression' &&
					parent.callee.type === 'Identifier' &&
					parent.callee.name === '$.child'
				) {
					node.metadata.is_controlled = true;
					visit(node, state);
				} else {
					state.init.push(b.var(name, expression));
					expression = b.call('$.sibling', id);

					visit(node, {
						...state,
						node: id
					});
				}
			}
		}
	}

	if (sequence.length > 0) {
		flush_sequence(sequence);
	}
}

/**
 * @param {true | Array<import('#compiler').Text | import('#compiler').ExpressionTag>} attribute_value
 * @param {import('../types').ComponentContext} context
 * @returns {[boolean, import('estree').Expression]}
 */
function serialize_attribute_value(attribute_value, context) {
	let contains_call_expression = false;

	if (attribute_value === true) {
		return [contains_call_expression, b.literal(true)];
	}

	if (attribute_value.length === 0) {
		return [contains_call_expression, b.literal('')]; // is this even possible?
	}

	if (attribute_value.length === 1) {
		const value = attribute_value[0];
		if (value.type === 'Text') {
			return [contains_call_expression, b.literal(value.data)];
		} else {
			if (value.type === 'ExpressionTag') {
				contains_call_expression = value.metadata.contains_call_expression;
			}
			return [
				contains_call_expression,
				/** @type {import('estree').Expression} */ (context.visit(value.expression))
			];
		}
	}

	return serialize_template_literal(attribute_value, context.visit, context.state);
}

/**
 * @param {Array<import('#compiler').Text | import('#compiler').ExpressionTag>} values
 * @param {(node: import('#compiler').SvelteNode) => any} visit
 * @param {import('../types.js').ComponentClientTransformState} state
 * @returns {[boolean, import('estree').TemplateLiteral]}
 */
function serialize_template_literal(values, visit, state) {
	/** @type {import('estree').TemplateElement[]} */
	const quasis = [];

	/** @type {import('estree').Expression[]} */
	const expressions = [];
	const scope = state.scope;
	let contains_call_expression = false;
	quasis.push(b.quasi(''));

	for (let i = 0; i < values.length; i++) {
		const node = values[i];
		if (node.type === 'Text') {
			const last = /** @type {import('estree').TemplateElement} */ (quasis.at(-1));
			last.value.raw += node.data;
		} else {
			if (node.type === 'ExpressionTag' && node.metadata.contains_call_expression) {
				contains_call_expression = true;
			}
			let expression = visit(node.expression);
			if (node.expression.type === 'Identifier') {
				const name = node.expression.name;
				const binding = scope.get(name);
				// When we combine expressions as part of a single template element, we might
				// be referencing variables that can be mutated, but are not actually state.
				// In order to prevent this undesired behavior, we need ensure we cache the
				// latest value we have of that variable before we process the template, enforcing
				// the value remains static through the lifetime of the template.
				if (binding !== null && binding.kind === 'normal' && binding.mutated) {
					let has_already_cached = false;
					// Check if we already create a const of this expression
					for (let node of state.init) {
						if (
							node.type === 'VariableDeclaration' &&
							node.declarations[0].id.type === 'Identifier' &&
							node.declarations[0].id.name === name + '_const'
						) {
							has_already_cached = true;
							expression = b.id(name + '_const');
							break;
						}
					}
					if (!has_already_cached) {
						const tmp_id = scope.generate(name + '_const');
						state.init.push(b.const(tmp_id, expression));
						expression = b.id(tmp_id);
					}
				}
			}
			expressions.push(b.call('$.stringify', expression));
			quasis.push(b.quasi('', i + 1 === values.length));
		}
	}

	return [contains_call_expression, b.template(quasis, expressions)];
}

/** @type {import('../types').ComponentVisitors} */
export const template_visitors = {
	Fragment(node, context) {
		const body = create_block(node, 'frag', node.nodes, context);
		return b.block(body);
	},
	Comment(node, context) {
		// We'll only get here if comments are not filtered out, which they are unless preserveComments is true
		context.state.template.push(`<!--${node.data}-->`);
	},
	HtmlTag(node, context) {
		context.state.template.push('<!>');

		// push into init, so that bindings run afterwards, which might trigger another run and override hydration
		context.state.init.push(
			b.stmt(
				b.call(
					'$.html',
					context.state.node,
					b.thunk(/** @type {import('estree').Expression} */ (context.visit(node.expression))),
					b.literal(context.state.metadata.namespace === 'svg')
				)
			)
		);
	},
	ConstTag(node, { state, visit }) {
		// TODO we can almost certainly share some code with $derived(...)
		if (node.expression.left.type === 'Identifier') {
			state.init.push(
				b.const(
					node.expression.left,
					b.call(
						'$.derived',
						b.thunk(/** @type {import('estree').Expression} */ (visit(node.expression.right)))
					)
				)
			);
		} else {
			const identifiers = extract_identifiers(node.expression.left);
			const tmp = b.id(state.scope.generate('computed_const'));

			// Make all identifiers that are declared within the following computed regular
			// variables, as they are not signals in that context yet
			for (const node of identifiers) {
				const binding = /** @type {import('#compiler').Binding} */ (state.scope.get(node.name));
				binding.expression = node;
			}

			// TODO optimise the simple `{ x } = y` case — we can just return `y`
			// instead of destructuring it only to return a new object
			const fn = b.arrow(
				[],
				b.block([
					b.const(
						/** @type {import('estree').Pattern} */ (visit(node.expression.left)),
						/** @type {import('estree').Expression} */ (visit(node.expression.right))
					),
					b.return(b.object(identifiers.map((node) => b.prop('init', node, node))))
				])
			);

			state.init.push(b.const(tmp, b.call('$.derived', fn)));

			for (const node of identifiers) {
				const binding = /** @type {import('#compiler').Binding} */ (state.scope.get(node.name));
				binding.expression = b.member(b.call('$.get', tmp), node);
			}
		}
	},
	DebugTag(node, { state, visit }) {
		state.init.push(
			b.stmt(
				b.call(
					'$.render_effect',
					b.thunk(
						b.block([
							b.stmt(
								b.call(
									'console.log',
									b.object(
										node.identifiers.map((identifier) =>
											b.prop(
												'init',
												identifier,
												/** @type {import('estree').Expression} */ (visit(identifier))
											)
										)
									)
								)
							),
							b.debugger
						])
					)
				)
			)
		);
	},
	RenderTag(node, context) {
		context.state.template.push('<!>');
		const binding = context.state.scope.get(node.expression.name);
		const is_reactive = binding?.kind !== 'normal' || node.expression.type !== 'Identifier';

		/** @type {import('estree').Expression[]} */
		const args = [context.state.node];
		if (node.argument) {
			args.push(b.thunk(/** @type {import('estree').Expression} */ (context.visit(node.argument))));
		}
		const snippet_function = /** @type {import('estree').Expression} */ (
			context.visit(node.expression)
		);
		const init = b.call(
			context.state.options.dev ? b.call('$.validate_snippet', snippet_function) : snippet_function,
			...args
		);

		if (is_reactive) {
			context.state.init.push(b.stmt(b.call('$.snippet_effect', b.thunk(init))));
		} else {
			context.state.init.push(b.stmt(init));
		}
	},
	AnimateDirective(node, { state, visit }) {
		const expression =
			node.expression === null
				? b.literal(null)
				: b.thunk(/** @type {import('estree').Expression} */ (visit(node.expression)));

		state.init.push(b.stmt(b.call('$.animate', state.node, b.id(node.name), expression)));
	},
	ClassDirective(node, { state, next }) {
		error(node, 'INTERNAL', 'Node should have been handled elsewhere');
	},
	StyleDirective(node, { state, next }) {
		error(node, 'INTERNAL', 'Node should have been handled elsewhere');
	},
	TransitionDirective(node, { state, visit }) {
		const type = node.intro && node.outro ? '$.transition' : node.intro ? '$.in' : '$.out';
		const expression =
			node.expression === null
				? b.literal(null)
				: b.thunk(/** @type {import('estree').Expression} */ (visit(node.expression)));

		state.init.push(
			b.stmt(
				b.call(
					type,
					state.node,
					b.id(node.name),
					expression,
					node.modifiers.includes('global') ? b.true : b.false
				)
			)
		);
	},
	RegularElement(node, context) {
		const metadata = context.state.metadata;
		const child_metadata = {
			...context.state.metadata,
			namespace: determine_element_namespace(node, context.state.metadata.namespace, context.path)
		};

		context.state.template.push(`<${node.name}`);

		/** @type {Array<import('#compiler').Attribute | import('#compiler').SpreadAttribute>} */
		const attributes = [];

		/** @type {import('#compiler').ClassDirective[]} */
		const class_directives = [];

		/** @type {import('#compiler').StyleDirective[]} */
		const style_directives = [];

		/** @type {import('estree').ExpressionStatement[]} */
		const lets = [];

		const is_custom_element = is_custom_element_node(node);
		let needs_input_reset = false;
		let needs_content_reset = false;
		let has_spread = false;

		/** @type {import('#compiler').BindDirective | null} */
		let value_binding = null;

		/** If true, needs `__value` for inputs */
		let needs_special_value_handling = node.name === 'option' || node.name === 'select';
		let is_content_editable = false;
		let has_content_editable_binding = false;

		if (is_custom_element) {
			// cloneNode is faster, but it does not instantiate the underlying class of the
			// custom element until the template is connected to the dom, which would
			// cause problems when setting properties on the custom element.
			// Therefore we need to use importNode instead, which doesn't have this caveat.
			metadata.template_needs_import_node = true;
		}

		for (const attribute of node.attributes) {
			if (attribute.type === 'Attribute') {
				if (is_event_attribute(attribute)) {
					serialize_event_attribute(attribute, context);
				} else {
					attributes.push(attribute);
					if (
						(attribute.name === 'value' || attribute.name === 'checked') &&
						!is_text_attribute(attribute)
					) {
						needs_input_reset = true;
						needs_content_reset = true;
					} else if (
						attribute.name === 'contenteditable' &&
						(attribute.value === true ||
							(is_text_attribute(attribute) && attribute.value[0].data === 'true'))
					) {
						is_content_editable = true;
					}
				}
			} else if (attribute.type === 'SpreadAttribute') {
				attributes.push(attribute);
				has_spread = true;
				needs_input_reset = true;
				needs_content_reset = true;
			} else if (attribute.type === 'ClassDirective') {
				class_directives.push(attribute);
			} else if (attribute.type === 'StyleDirective') {
				style_directives.push(attribute);
			} else if (attribute.type === 'LetDirective') {
				lets.push(/** @type {import('estree').ExpressionStatement} */ (context.visit(attribute)));
			} else {
				if (attribute.type === 'BindDirective') {
					if (attribute.name === 'group' || attribute.name === 'checked') {
						needs_special_value_handling = true;
						needs_input_reset = true;
					} else if (attribute.name === 'value') {
						value_binding = attribute;
						needs_content_reset = true;
						needs_input_reset = true;
					} else if (
						attribute.name === 'innerHTML' ||
						attribute.name === 'innerText' ||
						attribute.name === 'textContent'
					) {
						has_content_editable_binding = true;
					}
				}
				context.visit(attribute);
			}
		}

		if (child_metadata.namespace === 'foreign') {
			// input/select etc could mean something completely different in foreign namespace, so don't special-case them
			needs_content_reset = false;
			needs_input_reset = false;
			needs_special_value_handling = false;
			value_binding = null;
		}

		if (is_content_editable && has_content_editable_binding) {
			child_metadata.bound_contenteditable = true;
		}

		if (needs_input_reset && (node.name === 'input' || node.name === 'select')) {
			context.state.init.push(b.stmt(b.call('$.remove_input_attr_defaults', context.state.node)));
		}

		if (needs_content_reset && node.name === 'textarea') {
			context.state.init.push(b.stmt(b.call('$.remove_textarea_child', context.state.node)));
		}

		if (value_binding !== null && node.name === 'select') {
			setup_select_synchronization(value_binding, context);
		}

		const node_id = context.state.node;

		// Let bindings first, they can be used on attributes
		context.state.init.push(...lets);

		// Then do attributes
		let is_attributes_reactive = false;
		if (has_spread) {
			const spread_id = serialize_element_spread_attributes(attributes, context, node_id);
			if (child_metadata.namespace !== 'foreign') {
				add_select_to_spread_update(spread_id, node, context, node_id);
			}
			is_attributes_reactive = spread_id !== null;
		} else {
			for (const attribute of /** @type {import('#compiler').Attribute[]} */ (attributes)) {
				if (needs_special_value_handling && attribute.name === 'value') {
					serialize_element_special_value_attribute(node.name, node_id, attribute, context);
					continue;
				}

				if (
					attribute.name !== 'autofocus' &&
					(attribute.value === true || is_text_attribute(attribute))
				) {
					const name = get_attribute_name(attribute, context.state);
					const literal_value = /** @type {import('estree').Literal} */ (
						serialize_attribute_value(attribute.value, context)[1]
					).value;
					if (name !== 'class' || literal_value) {
						// TODO namespace=foreign probably doesn't want to do template stuff at all and instead use programmatic methods
						// to create the elements it needs.
						context.state.template.push(
							` ${attribute.name}${
								DOMBooleanAttributes.includes(name) && literal_value === true
									? ''
									: `="${literal_value === true ? '' : escape_html(String(literal_value), true)}"`
							}`
						);
						continue;
					}
				}

				const is =
					is_custom_element && child_metadata.namespace !== 'foreign'
						? serialize_custom_element_attribute_update_assignment(node_id, attribute, context)
						: serialize_element_attribute_update_assignment(node_id, attribute, context);
				if (is) is_attributes_reactive = true;
			}
		}

		// class/style directives must be applied last since they could override class/style attributes
		serialize_class_directives(class_directives, node_id, context, is_attributes_reactive);
		serialize_style_directives(style_directives, node_id, context, is_attributes_reactive);

		context.state.template.push('>');

		/** @type {import('../types').ComponentClientTransformState} */
		const state = {
			...context.state,
			metadata: child_metadata,
			scope: /** @type {import('../../../scope').Scope} */ (
				context.state.scopes.get(node.fragment)
			),
			preserve_whitespace:
				context.state.preserve_whitespace ||
				((node.name === 'pre' || node.name === 'textarea') &&
					child_metadata.namespace !== 'foreign')
		};

		const { hoisted, trimmed } = clean_nodes(
			node,
			node.fragment.nodes,
			context.path,
			child_metadata.namespace,
			state.preserve_whitespace,
			state.options.preserveComments,
			false
		);

		for (const node of hoisted) {
			context.visit(node, state);
		}

		process_children(
			trimmed,
			b.call(
				'$.child',
				node.name === 'template'
					? b.member(context.state.node, b.id('content'))
					: context.state.node
			),
			{ ...context, state }
		);

		if (!VoidElements.includes(node.name)) {
			context.state.template.push(`</${node.name}>`);
		}
	},
	SvelteElement(node, context) {
		context.state.template.push(`<!>`);

		/** @type {Array<import('#compiler').Attribute | import('#compiler').SpreadAttribute>} */
		const attributes = [];

		/** @type {import('#compiler').ClassDirective[]} */
		const class_directives = [];

		/** @type {import('#compiler').StyleDirective[]} */
		const style_directives = [];

		/** @type {import('estree').ExpressionStatement[]} */
		const lets = [];

		/** @type {string | null} */
		let namespace = null;

		// Create a temporary context which picks up the init/update statements.
		// They'll then be added to the function parameter of $.element
		const element_id = b.id(context.state.scope.generate('$$element'));

		/** @type {import('../types').ComponentContext} */
		const inner_context = {
			...context,
			state: {
				...context.state,
				node: element_id,
				init: [],
				update: [],
				update_effects: [],
				after_update: []
			}
		};

		for (const attribute of node.attributes) {
			if (attribute.type === 'Attribute') {
				attributes.push(attribute);
				if (attribute.name === 'xmlns' && is_text_attribute(attribute)) {
					namespace = attribute.value[0].data;
				}
			} else if (attribute.type === 'SpreadAttribute') {
				attributes.push(attribute);
			} else if (attribute.type === 'ClassDirective') {
				class_directives.push(attribute);
			} else if (attribute.type === 'StyleDirective') {
				style_directives.push(attribute);
			} else if (attribute.type === 'LetDirective') {
				lets.push(/** @type {import('estree').ExpressionStatement} */ (context.visit(attribute)));
			} else {
				context.visit(attribute, inner_context.state);
			}
		}

		// Let bindings first, they can be used on attributes
		context.state.init.push(...lets); // create computeds in the outer context; the dynamic element is the single child of this slot

		// Then do attributes
		// Always use spread because we don't know whether the element is a custom element or not,
		// therefore we need to do the "how to set an attribute" logic at runtime.
		const is_attributes_reactive =
			serialize_dynamic_element_spread_attributes(attributes, inner_context, element_id) !== null;

		// class/style directives must be applied last since they could override class/style attributes
		serialize_class_directives(class_directives, element_id, inner_context, is_attributes_reactive);
		serialize_style_directives(style_directives, element_id, inner_context, is_attributes_reactive);

		const get_tag = b.thunk(/** @type {import('estree').Expression} */ (context.visit(node.tag)));

		if (context.state.options.dev && context.state.metadata.namespace !== 'foreign') {
			if (node.fragment.nodes.length > 0) {
				context.state.init.push(b.stmt(b.call('$.validate_void_dynamic_element', get_tag)));
			}
			context.state.init.push(b.stmt(b.call('$.validate_dynamic_element_tag', get_tag)));
		}

		/** @type {import('estree').Statement[]} */
		const inner = inner_context.state.init;
		if (inner_context.state.update.length > 0 || inner_context.state.update_effects.length > 0) {
			if (inner_context.state.update_effects.length > 0) {
				for (const render of inner_context.state.update_effects) {
					inner.push(render);
				}
			}
			if (inner_context.state.update.length > 0) {
				let render;
				if (inner_context.state.update.length === 1 && inner_context.state.update[0].singular) {
					render = inner_context.state.update[0].singular;
				} else {
					render = b.stmt(
						b.call(
							'$.render_effect',
							b.thunk(
								b.block(
									inner_context.state.update.map((n) => {
										if (n.init) {
											inner.push(n.init);
										}
										return n.grouped;
									})
								)
							)
						)
					);
				}
				inner.push(render);
			}
		}
		inner.push(...inner_context.state.after_update);
		inner.push(...create_block(node, 'dynamic_element', node.fragment.nodes, context));
		context.state.after_update.push(
			b.stmt(
				b.call(
					'$.element',
					context.state.node,
					get_tag,
					b.arrow([element_id, b.id('$$anchor')], b.block(inner)),
					namespace === 'http://www.w3.org/2000/svg'
						? b.literal(true)
						: /** @type {any} */ (undefined)
				)
			)
		);
	},
	EachBlock(node, context) {
		const each_node_meta = node.metadata;
		const collection = /** @type {import('estree').Expression} */ (context.visit(node.expression));
		let each_item_is_reactive = true;

		if (!each_node_meta.is_controlled) {
			context.state.template.push('<!>');
		}

		if (each_node_meta.array_name !== null) {
			context.state.init.push(b.const(each_node_meta.array_name, b.thunk(collection)));
		}

		// The runtime needs to know what kind of each block this is in order to optimize for the
		// immutable + key==entry case. In that case, the item doesn't need to be reactive, because
		// the array as a whole is immutable, so if something changes, it either has to recreate the
		// array or use nested reactivity through runes.
		// TODO this feels a bit "hidden performance boost"-style, investigate if there's a way
		// to make this apply in more cases
		/** @type {number} */
		let each_type;

		if (node.key) {
			each_type = EACH_KEYED;
			if (
				node.key.type === 'Identifier' &&
				node.context.type === 'Identifier' &&
				node.context.name === node.key.name &&
				context.state.options.immutable
			) {
				// Fast-path
				each_item_is_reactive = false;
			} else {
				each_type |= EACH_ITEM_REACTIVE;
			}
			// If there's a destructuring, then we likely need the generated $$index
			if (node.index || node.context.type !== 'Identifier') {
				each_type |= EACH_INDEX_REACTIVE;
			}
		} else {
			each_type = EACH_ITEM_REACTIVE;
		}
		if (each_node_meta.is_controlled) {
			each_type |= EACH_IS_CONTROLLED;
		}

		// Find the parent each blocks which contain the arrays to invalidate
		// TODO decide how much of this we want to keep for runes mode. For now we're bailing out below
		const indirect_dependencies = collect_parent_each_blocks(context).flatMap((block) => {
			const array = /** @type {import('estree').Expression} */ (context.visit(block.expression));
			const transitive_dependencies = serialize_transitive_dependencies(
				block.metadata.references,
				context
			);
			return [array, ...transitive_dependencies];
		});
		if (each_node_meta.array_name) {
			indirect_dependencies.push(b.call(each_node_meta.array_name));
		} else {
			indirect_dependencies.push(collection);
			const transitive_dependencies = serialize_transitive_dependencies(
				each_node_meta.references,
				context
			);
			indirect_dependencies.push(...transitive_dependencies);
		}

		/**
		 * @param {import('estree').Pattern} expression_for_id
		 * @param {import('estree').Expression} expression_for_other
		 * @returns {import('#compiler').Binding['mutation']}
		 */
		const create_mutation = (expression_for_id, expression_for_other) => {
			return (assignment, context) => {
				if (assignment.left.type !== 'Identifier' && assignment.left.type !== 'MemberExpression') {
					// serialize_set_binding turns other patterns into IIFEs and separates the assignments
					// into separate expressions, at which point this is called again with an identifier or member expression
					return serialize_set_binding(assignment, context, () => assignment);
				}

				const left = object(assignment.left);
				const value = get_assignment_value(assignment, context);
				const invalidate = b.call(
					'$.invalidate_inner_signals',
					b.thunk(b.sequence(indirect_dependencies))
				);

				if (left === assignment.left) {
					const assign = b.assignment('=', expression_for_id, value);
					return context.state.analysis.runes ? assign : b.sequence([assign, invalidate]);
				} else {
					const original_left = /** @type {import('estree').MemberExpression} */ (assignment.left);
					const left = b.member(
						expression_for_other,
						context.visit(original_left).property,
						original_left.computed
					);
					const assign = b.assignment(assignment.operator, left, value);
					return context.state.analysis.runes ? assign : b.sequence([assign, invalidate]);
				}
			};
		};

		// We need to generate a unique identifier in case there's a bind:group below
		// which needs a reference to the index
		const index =
			each_node_meta.contains_group_binding || !node.index
				? each_node_meta.index
				: b.id(node.index);
		const item = b.id(each_node_meta.item_name);
		const binding = /** @type {import('#compiler').Binding} */ (context.state.scope.get(item.name));
		binding.expression = each_item_is_reactive ? b.call('$.unwrap', item) : item;

		/** @type {import('estree').Statement[]} */
		const declarations = [];

		if (node.context.type === 'Identifier') {
			binding.mutation = create_mutation(
				b.member(
					each_node_meta.array_name ? b.call(each_node_meta.array_name) : collection,
					index,
					true
				),
				binding.expression
			);
		} else {
			const unwrapped = binding.expression;
			const paths = extract_paths(node.context);

			for (const path of paths) {
				const name = /** @type {import('estree').Identifier} */ (path.node).name;
				const binding = /** @type {import('#compiler').Binding} */ (context.state.scope.get(name));
				declarations.push(
					b.let(
						path.node,
						b.thunk(
							/** @type {import('estree').Expression} */ (
								context.visit(path.expression?.(unwrapped))
							)
						)
					)
				);

				// we need to eagerly evaluate the expression in order to hit any
				// 'Cannot access x before initialization' errors
				if (context.state.options.dev) {
					declarations.push(b.stmt(b.call(name)));
				}

				binding.expression = b.call(name);
				binding.mutation = create_mutation(
					/** @type {import('estree').Pattern} */ (path.update_expression(unwrapped)),
					binding.expression
				);
			}
		}

		// TODO should use context.visit?
		const children = create_block(node, 'each_block', node.body.nodes, context);

		const else_block = node.fallback
			? b.arrow(
					[b.id('$$anchor')],
					/** @type {import('estree').BlockStatement} */ (context.visit(node.fallback))
			  )
			: b.literal(null);
		const key_function =
			node.key && (each_type & 1) /* EACH_ITEM_REACTIVE */ !== 0
				? b.arrow(
						[node.context.type === 'Identifier' ? node.context : b.id('$$item')],
						b.block(
							declarations.concat(
								b.return(/** @type {import('estree').Expression} */ (context.visit(node.key)))
							)
						)
				  )
				: b.literal(null);

		if (context.state.options.dev && key_function.type !== 'Literal') {
			context.state.init.push(
				b.stmt(b.call('$.validate_each_keys', b.thunk(collection), key_function))
			);
		}

		if (node.index && each_node_meta.contains_group_binding) {
			// We needed to create a unique identifier for the index above, but we want to use the
			// original index name in the template, therefore create another binding
			declarations.push(b.let(node.index, index));
		}

		context.state.after_update.push(
			b.stmt(
				b.call(
					'$.each',
					context.state.node,
					each_node_meta.array_name ? each_node_meta.array_name : b.thunk(collection),
					b.literal(each_type),
					key_function,
					b.arrow([b.id('$$anchor'), item, index], b.block(declarations.concat(children))),
					else_block
				)
			)
		);
	},
	IfBlock(node, context) {
		context.state.template.push('<!>');

		const consequent = /** @type {import('estree').BlockStatement} */ (
			context.visit(node.consequent)
		);

		context.state.after_update.push(
			b.stmt(
				b.call(
					'$.if',
					context.state.node,
					b.thunk(/** @type {import('estree').Expression} */ (context.visit(node.test))),
					b.arrow([b.id('$$anchor')], consequent),
					node.alternate
						? b.arrow(
								[b.id('$$anchor')],
								/** @type {import('estree').BlockStatement} */ (context.visit(node.alternate))
						  )
						: b.literal(null)
				)
			)
		);
	},
	AwaitBlock(node, context) {
		context.state.template.push('<!>');

		context.state.after_update.push(
			b.stmt(
				b.call(
					'$.await',
					context.state.node,
					b.thunk(/** @type {import('estree').Expression} */ (context.visit(node.expression))),
					node.pending
						? b.arrow(
								[b.id('$$anchor')],
								/** @type {import('estree').BlockStatement} */ (context.visit(node.pending))
						  )
						: b.literal(null),
					node.then
						? b.arrow(
								node.value
									? [
											b.id('$$anchor'),
											/** @type {import('estree').Pattern} */ (context.visit(node.value))
									  ]
									: [b.id('$$anchor')],
								/** @type {import('estree').BlockStatement} */ (context.visit(node.then))
						  )
						: b.literal(null),
					node.catch
						? b.arrow(
								node.error
									? [
											b.id('$$anchor'),
											/** @type {import('estree').Pattern} */ (context.visit(node.error))
									  ]
									: [b.id('$$anchor')],
								/** @type {import('estree').BlockStatement} */ (context.visit(node.catch))
						  )
						: b.literal(null)
				)
			)
		);
	},
	KeyBlock(node, context) {
		context.state.template.push('<!>');
		const key = /** @type {import('estree').Expression} */ (context.visit(node.expression));
		const body = /** @type {import('estree').Expression} */ (context.visit(node.fragment));
		context.state.after_update.push(
			b.stmt(b.call('$.key', context.state.node, b.thunk(key), b.arrow([b.id('$$anchor')], body)))
		);
	},
	SnippetBlock(node, context) {
		// TODO hoist where possible
		const args = [b.id('$$anchor')];

		/** @type {import('estree').BlockStatement} */
		let body;

		if (node.context) {
			const id = node.context.type === 'Identifier' ? node.context : b.id('$$context');
			args.push(id);

			/** @type {import('estree').Statement[]} */
			const declarations = [];

			// some of this is duplicated with EachBlock — TODO dedupe?
			if (node.context.type === 'Identifier') {
				const binding = /** @type {import('#compiler').Binding} */ (
					context.state.scope.get(id.name)
				);
				binding.expression = b.call(id);
			} else {
				const paths = extract_paths(node.context);

				for (const path of paths) {
					const name = /** @type {import('estree').Identifier} */ (path.node).name;
					const binding = /** @type {import('#compiler').Binding} */ (
						context.state.scope.get(name)
					);
					declarations.push(
						b.let(
							path.node,
							b.thunk(
								/** @type {import('estree').Expression} */ (
									context.visit(path.expression?.(b.call('$$context')))
								)
							)
						)
					);

					// we need to eagerly evaluate the expression in order to hit any
					// 'Cannot access x before initialization' errors
					if (context.state.options.dev) {
						declarations.push(b.stmt(b.call(name)));
					}

					binding.expression = b.call(name);
				}
			}

			body = b.block([
				...declarations,
				.../** @type {import('estree').BlockStatement} */ (context.visit(node.body)).body
			]);
		} else {
			body = /** @type {import('estree').BlockStatement} */ (context.visit(node.body));
		}

		context.state.init.push(b.function_declaration(node.expression, args, body));
		if (context.state.options.dev) {
			context.state.init.push(b.stmt(b.call('$.add_snippet_symbol', node.expression)));
		}
	},
	FunctionExpression: function_visitor,
	ArrowFunctionExpression: function_visitor,
	FunctionDeclaration(node, context) {
		context.next({ ...context.state, in_constructor: false });
	},
	OnDirective(node, context) {
		serialize_event(node, context);
	},
	UseDirective(node, { state, next, visit }) {
		const params = [b.id('$$node')];

		if (node.expression) {
			params.push(b.id('$$props'));
		}

		/** @type {import('estree').Expression[]} */
		const args = [
			state.node,
			b.arrow(params, b.call(serialize_get_binding(b.id(node.name), state), ...params))
		];

		if (node.expression) {
			args.push(b.thunk(/** @type {import('estree').Expression} */ (visit(node.expression))));
		}

		// actions need to run after attribute updates in order with bindings/events
		state.after_update.push(b.stmt(b.call('$.action', ...args)));
		next();
	},
	BindDirective(node, context) {
		const { state, path } = context;

		/** @type {import('estree').Expression[]} */
		const properties = [];

		let expression = node.expression;
		while (expression.type === 'MemberExpression') {
			properties.unshift(
				expression.computed
					? /** @type {import('estree').Expression} */ (expression.property)
					: b.literal(/** @type {import('estree').Identifier} */ (expression.property).name)
			);
			expression = /** @type {import('estree').Identifier | import('estree').MemberExpression} */ (
				expression.object
			);
		}

		const getter = b.thunk(
			/** @type {import('estree').Expression} */ (context.visit(node.expression))
		);
		const assignment = b.assignment('=', node.expression, b.id('$$value'));
		const setter = b.arrow(
			[b.id('$$value')],
			serialize_set_binding(
				assignment,
				context,
				() => /** @type {import('estree').Expression} */ (context.visit(assignment))
			)
		);

		/** @type {import('estree').CallExpression} */
		let call_expr;

		const property = binding_properties[node.name];
		if (property && property.event) {
			call_expr = b.call(
				'$.bind_property',
				b.literal(node.name),
				b.literal(property.event),
				b.literal(property.type ?? 'get'),
				state.node,
				getter,
				setter
			);
		} else {
			// special cases
			switch (node.name) {
				// window
				case 'online':
					call_expr = b.call(`$.bind_online`, setter);
					break;

				case 'scrollX':
				case 'scrollY':
					call_expr = b.call(
						'$.bind_window_scroll',
						b.literal(node.name === 'scrollX' ? 'x' : 'y'),
						getter,
						setter
					);
					break;

				case 'innerWidth':
				case 'innerHeight':
				case 'outerWidth':
				case 'outerHeight':
					call_expr = b.call('$.bind_window_size', b.literal(node.name), setter);
					break;

				// media
				case 'muted':
					call_expr = b.call(`$.bind_muted`, state.node, getter, setter);
					break;
				case 'paused':
					call_expr = b.call(`$.bind_paused`, state.node, getter, setter);
					break;
				case 'volume':
					call_expr = b.call(`$.bind_volume`, state.node, getter, setter);
					break;
				case 'playbackRate':
					call_expr = b.call(`$.bind_playback_rate`, state.node, getter, setter);
					break;
				case 'currentTime':
					call_expr = b.call(`$.bind_current_time`, state.node, getter, setter);
					break;
				case 'buffered':
					call_expr = b.call(`$.bind_buffered`, state.node, setter);
					break;
				case 'played':
					call_expr = b.call(`$.bind_played`, state.node, setter);
					break;
				case 'seekable':
					call_expr = b.call(`$.bind_seekable`, state.node, setter);
					break;
				case 'seeking':
					call_expr = b.call(`$.bind_seeking`, state.node, setter);
					break;
				case 'ended':
					call_expr = b.call(`$.bind_ended`, state.node, setter);
					break;
				case 'readyState':
					call_expr = b.call(`$.bind_ready_state`, state.node, setter);
					break;

				// dimensions
				case 'contentRect':
				case 'contentBoxSize':
				case 'borderBoxSize':
				case 'devicePixelContentBoxSize':
					call_expr = b.call('$.bind_resize_observer', state.node, b.literal(node.name), setter);
					break;

				case 'clientWidth':
				case 'clientHeight':
				case 'offsetWidth':
				case 'offsetHeight':
					call_expr = b.call('$.bind_element_size', state.node, b.literal(node.name), setter);
					break;

				// various
				case 'value': {
					const parent = path.at(-1);
					if (parent?.type === 'RegularElement' && parent.name === 'select') {
						call_expr = b.call(`$.bind_select_value`, state.node, getter, setter);
					} else {
						call_expr = b.call(`$.bind_value`, state.node, getter, setter);
					}
					break;
				}

				case 'this':
					call_expr = b.call(`$.bind_this`, state.node, setter);
					break;

				case 'textContent':
				case 'innerHTML':
				case 'innerText':
					call_expr = b.call(
						'$.bind_content_editable',
						b.literal(node.name),
						state.node,
						getter,
						setter
					);
					break;

				// checkbox/radio
				case 'checked':
					call_expr = b.call(`$.bind_checked`, state.node, getter, setter);
					break;

				case 'group': {
					/** @type {import('estree').CallExpression[]} */
					const indexes = [];
					// we only care about the indexes above the first each block
					for (const parent_each_block of node.metadata.parent_each_blocks.slice(0, -1)) {
						indexes.push(b.call('$.unwrap', parent_each_block.metadata.index));
					}

					// We need to additionally invoke the value attribute signal to register it as a dependency,
					// so that when the value is updated, the group binding is updated
					let group_getter = getter;
					const parent = path.at(-1);
					if (parent?.type === 'RegularElement') {
						const value = /** @type {any[]} */ (
							/** @type {import('#compiler').Attribute} */ (
								parent.attributes.find(
									(a) =>
										a.type === 'Attribute' &&
										a.name === 'value' &&
										!is_text_attribute(a) &&
										a.value !== true
								)
							)?.value
						);
						if (value !== undefined) {
							group_getter = b.thunk(
								b.block([
									b.stmt(serialize_attribute_value(value, context)[1]),
									b.return(
										/** @type {import('estree').Expression} */ (context.visit(node.expression))
									)
								])
							);
						}
					}

					call_expr = b.call(
						'$.bind_group',
						node.metadata.binding_group_name,
						b.array(indexes),
						state.node,
						group_getter,
						setter
					);
					break;
				}

				default:
					error(node, 'INTERNAL', 'unknown binding ' + node.name);
			}
		}

		// Bindings need to happen after attribute updates, therefore after the render effect, and in order with events/actions.
		// bind:this is a special case as it's one-way and could influence the render effect.
		if (node.name === 'this') {
			state.init.push(b.stmt(call_expr));
		} else {
			state.after_update.push(b.stmt(call_expr));
		}
	},
	Component(node, context) {
		context.state.template.push('<!>');

		const binding = context.state.scope.get(
			node.name.includes('.') ? node.name.slice(0, node.name.indexOf('.')) : node.name
		);
		if (binding !== null && binding.kind !== 'normal') {
			// Handle dynamic references to what seems like static inline components
			const component = serialize_inline_component(node, '$$component', context);
			context.state.after_update.push(
				b.stmt(
					b.call(
						'$.component',
						context.state.node,
						// TODO use untrack here to not update when binding changes?
						// Would align with Svelte 4 behavior, but it's arguably nicer/expected to update this
						b.thunk(
							/** @type {import('estree').Expression} */ (context.visit(b.member_id(node.name)))
						),
						b.arrow([b.id('$$component')], b.block([component]))
					)
				)
			);
			return;
		}
		const component = serialize_inline_component(node, node.name, context);
		context.state.after_update.push(component);
	},
	SvelteSelf(node, context) {
		context.state.template.push('<!>');
		const component = serialize_inline_component(node, context.state.analysis.name, context);
		context.state.after_update.push(component);
	},
	SvelteComponent(node, context) {
		context.state.template.push('<!>');

		let component = serialize_inline_component(node, '$$component', context);
		if (context.state.options.dev) {
			component = b.stmt(b.call('$.validate_dynamic_component', b.thunk(b.block([component]))));
		}
		context.state.after_update.push(
			b.stmt(
				b.call(
					'$.component',
					context.state.node,
					b.thunk(/** @type {import('estree').Expression} */ (context.visit(node.expression))),
					b.arrow([b.id('$$component')], b.block([component]))
				)
			)
		);
	},
	Attribute(node, context) {
		if (is_event_attribute(node)) {
			serialize_event_attribute(node, context);
		}
	},
	LetDirective(node, { state, path }) {
		// let:x        -->  const x = $.derived(() => $.unwrap($$slotProps).x);
		// let:x={{y, z}}  -->  const derived_x = $.derived(() => { const { y, z } = $.unwrap($$slotProps).x; return { y, z }));
		const parent = path.at(-1);
		if (
			parent === undefined ||
			(parent.type !== 'Component' &&
				parent.type !== 'RegularElement' &&
				parent.type !== 'SvelteFragment')
		) {
			error(node, 'INTERNAL', 'let directive at invalid position');
		}

		if (node.expression && node.expression.type !== 'Identifier') {
			const name = state.scope.generate(node.name);
			const bindings = state.scope.get_bindings(node);

			for (const binding of bindings) {
				binding.expression = b.member(b.call('$.get', b.id(name)), b.id(binding.node.name));
			}

			return b.const(
				name,
				b.call(
					'$.derived',
					b.thunk(
						b.block([
							b.let(
								/** @type {import('estree').Expression} */ (node.expression).type ===
									'ObjectExpression'
									? // @ts-expect-error types don't match, but it can't contain spread elements and the structure is otherwise fine
									  b.object_pattern(node.expression.properties)
									: // @ts-expect-error types don't match, but it can't contain spread elements and the structure is otherwise fine
									  b.array_pattern(node.expression.elements),
								b.member(b.call('$.unwrap', b.id('$$slotProps')), b.id(node.name))
							),
							b.return(b.object(bindings.map((binding) => b.init(binding.node.name, binding.node))))
						])
					)
				)
			);
		} else {
			const name = node.expression === null ? node.name : node.expression.name;
			return b.const(
				name,
				b.call(
					'$.derived',
					b.thunk(b.member(b.call('$.unwrap', b.id('$$slotProps')), b.id(node.name)))
				)
			);
		}
	},
	SpreadAttribute(node, { visit }) {
		return visit(node.expression);
	},
	SvelteFragment(node, context) {
		/** @type {import('estree').Statement[]} */
		const lets = [];

		for (const attribute of node.attributes) {
			if (attribute.type === 'LetDirective') {
				lets.push(/** @type {import('estree').ExpressionStatement} */ (context.visit(attribute)));
			}
		}

		const state = {
			...context.state,
			// TODO this logic eventually belongs in create_block, when fragments are used everywhere
			scope: /** @type {import('../../../scope').Scope} */ (context.state.scopes.get(node.fragment))
		};

		context.state.init.push(...lets);
		context.state.init.push(
			...create_block(
				node,
				'slot_template',
				/** @type {import('#compiler').SvelteNode[]} */ (node.fragment.nodes),
				{
					...context,
					state
				}
			)
		);
	},
	SlotElement(node, context) {
		// <slot {a}>fallback</slot>  -->   $.slot($$slots.default, { get a() { .. } }, () => ...fallback);
		context.state.template.push('<!>');

		/** @type {import('estree').Property[]} */
		const props = [];

		/** @type {import('estree').Expression[]} */
		const spreads = [];

		let is_default = true;

		/** @type {import('estree').Expression} */
		let name = b.literal('default');

		for (const attribute of node.attributes) {
			if (attribute.type === 'SpreadAttribute') {
				spreads.push(/** @type {import('estree').Expression} */ (context.visit(attribute)));
			} else if (attribute.type === 'Attribute') {
				const [, value] = serialize_attribute_value(attribute.value, context);
				if (attribute.name === 'name') {
					name = value;
					is_default = false;
				} else {
					if (attribute.metadata.dynamic) {
						props.push(b.get(attribute.name, [b.return(value)]));
					} else {
						props.push(b.init(attribute.name, value));
					}
				}
			}
		}

		const props_expression =
			spreads.length === 0
				? b.object(props)
				: b.call('$.spread_props', b.thunk(b.array([b.object(props), ...spreads])));
		const fallback =
			node.fragment.nodes.length === 0
				? b.literal(null)
				: b.arrow(
						[b.id('$$anchor')],
						b.block(create_block(node, 'fallback', node.fragment.nodes, context))
				  );

		const expression = is_default
			? b.member(b.call('$.unwrap', b.id('$$props')), b.id('children'))
			: b.member(b.member(b.call('$.unwrap', b.id('$$props')), b.id('$$slots')), name, true, true);

		const slot = b.call('$.slot', context.state.node, expression, props_expression, fallback);
		context.state.init.push(b.stmt(slot));
	},
	SvelteHead(node, context) {
		// TODO attributes?
		context.state.init.push(
			b.stmt(
				b.call(
					'$.head',
					b.arrow(
						[b.id('$$anchor')],
						b.block(create_block(node, 'head', node.fragment.nodes, context))
					)
				)
			)
		);
	},
	TitleElement(node, { state, visit }) {
		// TODO throw validation error when attributes present / when children something else than text/expression tags
		if (node.fragment.nodes.length === 1 && node.fragment.nodes[0].type === 'Text') {
			state.init.push(
				b.stmt(
					b.assignment(
						'=',
						b.member(b.id('$.document'), b.id('title')),
						b.literal(/** @type {import('#compiler').Text} */ (node.fragment.nodes[0]).data)
					)
				)
			);
		} else {
			state.update.push({
				grouped: b.stmt(
					b.assignment(
						'=',
						b.member(b.id('$.document'), b.id('title')),
						serialize_template_literal(/** @type {any} */ (node.fragment.nodes), visit, state)[1]
					)
				)
			});
		}
	},
	SvelteBody(node, context) {
		context.next({
			...context.state,
			node: b.id('$.document.body')
		});
	},
	SvelteWindow(node, context) {
		context.next({
			...context.state,
			node: b.id('$.window')
		});
	},
	SvelteDocument(node, context) {
		context.next({
			...context.state,
			node: b.id('$.document')
		});
	}
};
