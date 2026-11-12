// Browse-view preload. It runs in an isolated world next to untrusted pages and
// deliberately exposes nothing to them. Later slices add image discovery, the
// scroll queue and the overlay here; they talk to main with ipcRenderer only.
export {}
