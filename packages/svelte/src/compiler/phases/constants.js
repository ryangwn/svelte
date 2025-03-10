export const DOMBooleanAttributes = [
	'allowfullscreen',
	'async',
	'autofocus',
	'autoplay',
	'checked',
	'controls',
	'default',
	'disabled',
	'formnovalidate',
	'hidden',
	'indeterminate',
	'ismap',
	'loop',
	'multiple',
	'muted',
	'nomodule',
	'novalidate',
	'open',
	'playsinline',
	'readonly',
	'required',
	'reversed',
	'seamless',
	'selected'
];

export const DOMProperties = [
	'className',
	'value',
	'readOnly',
	'formNoValidate',
	'isMap',
	'noModule',
	'playsInline',
	'inert',
	...DOMBooleanAttributes
];

/** @type {Record<string, string>} */
export const AttributeAliases = {
	class: 'className',
	formnovalidate: 'formNoValidate',
	ismap: 'isMap',
	nomodule: 'noModule',
	playsinline: 'playsInline',
	readonly: 'readOnly'
};

export const VoidElements = [
	'area',
	'base',
	'br',
	'col',
	'embed',
	'hr',
	'img',
	'input',
	'keygen',
	'link',
	'menuitem',
	'meta',
	'param',
	'source',
	'track',
	'wbr'
];

// list of Element events that will be delegated
export const DelegatedEvents = [
	'beforeinput',
	'click',
	'dblclick',
	'contextmenu',
	'focusin',
	'focusout',
	// 'input', This conflicts with bind:input
	'keydown',
	'keyup',
	'mousedown',
	'mousemove',
	'mouseout',
	'mouseover',
	'mouseup',
	'pointerdown',
	'pointermove',
	'pointerout',
	'pointerover',
	'pointerup',
	'touchend',
	'touchmove',
	'touchstart'
];

export const PassiveEvents = ['wheel', 'touchstart', 'touchmove', 'touchend', 'touchcancel'];

// TODO this is currently unused
export const ElementBindings = [
	'this',
	'value',
	'checked',
	'files',
	'group',
	'visibilityState',
	'fullscreenElement',
	'innerWidth',
	'innerHeight',
	'outerWidth',
	'outerHeight',
	'scrollX',
	'scrollY',
	'online',
	'devicePixelRatio',
	'naturalWidth',
	'naturalHeight',
	'clientWidth',
	'clientHeight',
	'offsetWidth',
	'offsetHeight',
	'duration',
	'buffered',
	'played',
	'seekable',
	'seeking',
	'ended',
	'readyState',
	'currentTime',
	'playbackRate',
	'paused',
	'volume',
	'muted',
	'innerHTML',
	'innerText',
	'textContent',
	'open',
	'indeterminate'
];

export const Runes = ['$state', '$props', '$derived', '$effect'];

/**
 * Whitespace inside one of these elements will not result in
 * a whitespace node being created in any circumstances. (This
 * list is almost certainly very incomplete)
 * TODO this is currently unused
 */
export const ElementsWithoutText = ['audio', 'datalist', 'dl', 'optgroup', 'select', 'video'];

export const ReservedKeywords = ['$$props', '$$restProps', '$$slots'];

/** Attributes where whitespace can be compacted */
export const WhitespaceInsensitiveAttributes = ['class', 'style'];

export const ContentEditableBindings = ['textContent', 'innerHTML', 'innerText'];

export const SVGElements = [
	'altGlyph',
	'altGlyphDef',
	'altGlyphItem',
	'animate',
	'animateColor',
	'animateMotion',
	'animateTransform',
	'circle',
	'clipPath',
	'color-profile',
	'cursor',
	'defs',
	'desc',
	'discard',
	'ellipse',
	'feBlend',
	'feColorMatrix',
	'feComponentTransfer',
	'feComposite',
	'feConvolveMatrix',
	'feDiffuseLighting',
	'feDisplacementMap',
	'feDistantLight',
	'feDropShadow',
	'feFlood',
	'feFuncA',
	'feFuncB',
	'feFuncG',
	'feFuncR',
	'feGaussianBlur',
	'feImage',
	'feMerge',
	'feMergeNode',
	'feMorphology',
	'feOffset',
	'fePointLight',
	'feSpecularLighting',
	'feSpotLight',
	'feTile',
	'feTurbulence',
	'filter',
	'font',
	'font-face',
	'font-face-format',
	'font-face-name',
	'font-face-src',
	'font-face-uri',
	'foreignObject',
	'g',
	'glyph',
	'glyphRef',
	'hatch',
	'hatchpath',
	'hkern',
	'image',
	'line',
	'linearGradient',
	'marker',
	'mask',
	'mesh',
	'meshgradient',
	'meshpatch',
	'meshrow',
	'metadata',
	'missing-glyph',
	'mpath',
	'path',
	'pattern',
	'polygon',
	'polyline',
	'radialGradient',
	'rect',
	'set',
	'solidcolor',
	'stop',
	'svg',
	'switch',
	'symbol',
	'text',
	'textPath',
	'tref',
	'tspan',
	'unknown',
	'use',
	'view',
	'vkern'
];
