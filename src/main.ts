import { Plugin } from "obsidian";

export default class AtlasPlugin extends Plugin {
	async onload() {
		console.log("Atlas: loading (scaffold — no features implemented yet)");
	}

	onunload() {
		console.log("Atlas: unloading");
	}
}
