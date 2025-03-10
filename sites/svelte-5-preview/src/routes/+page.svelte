<script>
	import { theme } from '@sveltejs/site-kit/stores';
	import '@sveltejs/site-kit/styles/index.css';

	import Repl from '$lib/Repl.svelte';
	import { onMount } from 'svelte';
	import { default_files } from './defaults.js';
	import { compress_and_encode_text, decode_and_decompress_text } from './gzip.js';

	/** @type {Repl} */
	let repl;

	let setting_hash = false;
	let started = false;

	onMount(change_from_hash);

	async function change_from_hash() {
		const hash = location.hash.slice(1);

		if (!hash) {
			repl.set({
				files: default_files
			});

			return;
		}

		try {
			// Uncompressed hashes that were used at some point start with 'ey' (JSON)
			const data = hash.startsWith('ey')
				? atob(hash.replaceAll('-', '+').replaceAll('_', '/'))
				: await decode_and_decompress_text(hash);
			let files;

			try {
				files = JSON.parse(data).files;
			} catch {
				// probably an old link from when we only had a single component
				files = [
					{
						name: 'App',
						type: 'svelte',
						source: data
					}
				];
			}

			repl.set({
				files
			});
		} catch {
			alert(`Couldn't load the code from the URL. Make sure you copied the link correctly.`);
		}
	}

	/** @param {CustomEvent<any>} e*/
	async function change_from_editor(e) {
		if (!started) {
			started = true; // ignore initial change caused by the repl.set in change_from_hash
			return;
		}

		const json = JSON.stringify({
			files: e.detail.files
		});

		setting_hash = true;

		history.replaceState(
			history.state,
			'',
			`${location.pathname}${location.search}#${await compress_and_encode_text(json)}`
		);
	}
</script>

<svelte:window
	on:hashchange={(e) => {
		if (!setting_hash) {
			change_from_hash();
		}

		setting_hash = false;
	}}
/>

<Repl
	bind:this={repl}
	autocomplete={true}
	on:add={change_from_editor}
	on:change={change_from_editor}
	on:remove={change_from_editor}
	previewTheme={$theme.current}
/>
