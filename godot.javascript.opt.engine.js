var Preloader = /** @constructor */ function() {

	var DOWNLOAD_ATTEMPTS_MAX = 4;
	var progressFunc = null;
	var lastProgress = { loaded: 0, total: 0 };

	var loadingFiles = {};
	this.preloadedFiles = [];

	function loadXHR(resolve, reject, file, tracker) {
		var xhr = new XMLHttpRequest;
		xhr.open('GET', file);
		if (!file.endsWith('.js')) {
			xhr.responseType = 'arraybuffer';
		}
		['loadstart', 'progress', 'load', 'error', 'abort'].forEach(function(ev) {
			xhr.addEventListener(ev, onXHREvent.bind(xhr, resolve, reject, file, tracker));
		});
		xhr.send();
	}

	function onXHREvent(resolve, reject, file, tracker, ev) {

		if (this.status >= 400) {

			if (this.status < 500 || ++tracker[file].attempts >= DOWNLOAD_ATTEMPTS_MAX) {
				reject(new Error("Failed loading file '" + file + "': " + this.statusText));
				this.abort();
				return;
			} else {
				setTimeout(loadXHR.bind(null, resolve, reject, file, tracker), 1000);
			}
		}

		switch (ev.type) {
			case 'loadstart':
				if (tracker[file] === undefined) {
					tracker[file] = {
						total: ev.total,
						loaded: ev.loaded,
						attempts: 0,
						final: false,
					};
				}
				break;

			case 'progress':
				tracker[file].loaded = ev.loaded;
				tracker[file].total = ev.total;
				break;

			case 'load':
				tracker[file].final = true;
				resolve(this);
				break;

			case 'error':
				if (++tracker[file].attempts >= DOWNLOAD_ATTEMPTS_MAX) {
					tracker[file].final = true;
					reject(new Error("Failed loading file '" + file + "'"));
				} else {
					setTimeout(loadXHR.bind(null, resolve, reject, file, tracker), 1000);
				}
				break;

			case 'abort':
				tracker[file].final = true;
				reject(new Error("Loading file '" + file + "' was aborted."));
				break;
		}
	}

	this.loadPromise = function(file) {
		return new Promise(function(resolve, reject) {
			loadXHR(resolve, reject, file, loadingFiles);
		});
	}

	this.preload = function(pathOrBuffer, destPath) {
		if (pathOrBuffer instanceof ArrayBuffer) {
			pathOrBuffer = new Uint8Array(pathOrBuffer);
		} else if (ArrayBuffer.isView(pathOrBuffer)) {
			pathOrBuffer = new Uint8Array(pathOrBuffer.buffer);
		}
		if (pathOrBuffer instanceof Uint8Array) {
			this.preloadedFiles.push({
				path: destPath,
				buffer: pathOrBuffer
			});
			return Promise.resolve();
		} else if (typeof pathOrBuffer === 'string') {
			var me = this;
			return this.loadPromise(pathOrBuffer).then(function(xhr) {
				me.preloadedFiles.push({
					path: destPath || pathOrBuffer,
					buffer: xhr.response
				});
				return Promise.resolve();
			});
		} else {
			throw Promise.reject("Invalid object for preloading");
		}
	};

	var animateProgress = function() {

		var loaded = 0;
		var total = 0;
		var totalIsValid = true;
		var progressIsFinal = true;

		Object.keys(loadingFiles).forEach(function(file) {
			const stat = loadingFiles[file];
			if (!stat.final) {
				progressIsFinal = false;
			}
			if (!totalIsValid || stat.total === 0) {
				totalIsValid = false;
				total = 0;
			} else {
				total += stat.total;
			}
			loaded += stat.loaded;
		});
		if (loaded !== lastProgress.loaded || total !== lastProgress.total) {
			lastProgress.loaded = loaded;
			lastProgress.total = total;
			if (typeof progressFunc === 'function')
				progressFunc(loaded, total);
		}
		if (!progressIsFinal)
			requestAnimationFrame(animateProgress);
	}
	this.animateProgress = animateProgress; // Also exposed to start it.

	this.setProgressFunc = function(callback) {
		progressFunc = callback;
	}
};

var Utils = {

	createLocateRewrite: function(execName) {
		function rw(path) {
			if (path.endsWith('.worker.js')) {
				return execName + '.worker.js';
			} else if (path.endsWith('.js')) {
				return execName + '.js';
			} else if (path.endsWith('.wasm')) {
				return execName + '.wasm';
			}
		}
		return rw;
	},

	createInstantiatePromise: function(wasmLoader) {
		function instantiateWasm(imports, onSuccess) {
			wasmLoader.then(function(xhr) {
				WebAssembly.instantiate(xhr.response, imports).then(function(result) {
					onSuccess(result['instance'], result['module']);
				});
			});
			wasmLoader = null;
			return {};
		};

		return instantiateWasm;
	},

	findCanvas: function() {
		var nodes = document.getElementsByTagName('canvas');
		if (nodes.length && nodes[0] instanceof HTMLCanvasElement) {
			return nodes[0];
		}
		throw new Error("No canvas found");
	},

	isWebGLAvailable: function(majorVersion = 1) {

		var testContext = false;
		try {
			var testCanvas = document.createElement('canvas');
			if (majorVersion === 1) {
				testContext = testCanvas.getContext('webgl') || testCanvas.getContext('experimental-webgl');
			} else if (majorVersion === 2) {
				testContext = testCanvas.getContext('webgl2') || testCanvas.getContext('experimental-webgl2');
			}
		} catch (e) {}
		return !!testContext;
	}
};

Function('return this')()['Engine'] = (function() {
	var preloader = new Preloader();

	var wasmExt = '.wasm';
	var unloadAfterInit = true;
	var loadPath = '';
	var loadPromise = null;
	var initPromise = null;
	var stderr = null;
	var stdout = null;
	var progressFunc = null;

	function load(basePath) {
		if (loadPromise == null) {
			loadPath = basePath;
			loadPromise = preloader.loadPromise(basePath + wasmExt);
			preloader.setProgressFunc(progressFunc);
			requestAnimationFrame(preloader.animateProgress);
		}
		return loadPromise;
	};

	function unload() {
		loadPromise = null;
	};

	/** @constructor */
	function Engine() {
		this.canvas = null;
		this.executableName = '';
		this.rtenv = null;
		this.customLocale = null;
		this.resizeCanvasOnStart = false;
		this.onExecute = null;
		this.onExit = null;
	};

	Engine.prototype.init = /** @param {string=} basePath */ function(basePath) {
		if (initPromise) {
			return initPromise;
		}
		if (loadPromise == null) {
			if (!basePath) {
				initPromise = Promise.reject(new Error("A base path must be provided when calling `init` and the engine is not loaded."));
				return initPromise;
			}
			load(basePath);
		}
		var config = {};
		if (typeof stdout === 'function')
			config.print = stdout;
		if (typeof stderr === 'function')
			config.printErr = stderr;
		var me = this;
		initPromise = new Promise(function(resolve, reject) {
			config['locateFile'] = Utils.createLocateRewrite(loadPath);
			config['instantiateWasm'] = Utils.createInstantiatePromise(loadPromise);
			Godot(config).then(function(module) {
				me.rtenv = module;
				if (unloadAfterInit) {
					unload();
				}
				resolve();
				config = null;
			});
		});
		return initPromise;
	};

	/** @type {function(string, string):Object} */
	Engine.prototype.preloadFile = function(file, path) {
		return preloader.preload(file, path);
	};

	/** @type {function(...string):Object} */
	Engine.prototype.start = function() {
		// Start from arguments.
		var args = [];
		for (var i = 0; i < arguments.length; i++) {
			args.push(arguments[i]);
		}
		var me = this;
		return me.init().then(function() {
			if (!me.rtenv) {
				return Promise.reject(new Error('The engine must be initialized before it can be started'));
			}

			if (!(me.canvas instanceof HTMLCanvasElement)) {
				me.canvas = Utils.findCanvas();
			}

			// Canvas can grab focus on click, or key events won't work.
			if (me.canvas.tabIndex < 0) {
				me.canvas.tabIndex = 0;
			}

			// Disable right-click context menu.
			me.canvas.addEventListener('contextmenu', function(ev) {
				ev.preventDefault();
			}, false);

			// Until context restoration is implemented warn the user of context loss.
			me.canvas.addEventListener('webglcontextlost', function(ev) {
				alert("WebGL context lost, please reload the page");
				ev.preventDefault();
			}, false);

			// Browser locale, or custom one if defined.
			var locale = me.customLocale;
			if (!locale) {
				locale = navigator.languages ? navigator.languages[0] : navigator.language;
				locale = locale.split('.')[0];
			}
			me.rtenv['locale'] = locale;
			me.rtenv['canvas'] = me.canvas;
			me.rtenv['thisProgram'] = me.executableName;
			me.rtenv['resizeCanvasOnStart'] = me.resizeCanvasOnStart;
			me.rtenv['noExitRuntime'] = true;
			me.rtenv['onExecute'] = me.onExecute;
			me.rtenv['onExit'] = function(code) {
				if (me.onExit)
					me.onExit(code);
				me.rtenv = null;
			}
			return new Promise(function(resolve, reject) {
				preloader.preloadedFiles.forEach(function(file) {
					me.rtenv['copyToFS'](file.path, file.buffer);
				});
				preloader.preloadedFiles.length = 0; // Clear memory
				me.rtenv['callMain'](args);
				initPromise = null;
				resolve();
			});
		});
	};

	Engine.prototype.startGame = function(execName, mainPack, extraArgs) {
		// Start and init with execName as loadPath if not inited.
		this.executableName = execName;
		var me = this;
		return Promise.all([
			this.init(execName),
			this.preloadFile(mainPack, mainPack)
		]).then(function() {
			var args = ['--main-pack', mainPack];
			if (extraArgs)
				args = args.concat(extraArgs);
			return me.start.apply(me, args);
		});
	};

	Engine.prototype.setWebAssemblyFilenameExtension = function(override) {
		if (String(override).length === 0) {
			throw new Error('Invalid WebAssembly filename extension override');
		}
		wasmExt = String(override);
	};

	Engine.prototype.setUnloadAfterInit = function(enabled) {
		unloadAfterInit = enabled;
	};

	Engine.prototype.setCanvas = function(canvasElem) {
		this.canvas = canvasElem;
	};

	Engine.prototype.setCanvasResizedOnStart = function(enabled) {
		this.resizeCanvasOnStart = enabled;
	};

	Engine.prototype.setLocale = function(locale) {
		this.customLocale = locale;
	};

	Engine.prototype.setExecutableName = function(newName) {
		this.executableName = newName;
	};

	Engine.prototype.setProgressFunc = function(func) {
		progressFunc = func;
	};

	Engine.prototype.setStdoutFunc = function(func) {
		var print = function(text) {
			if (arguments.length > 1) {
				text = Array.prototype.slice.call(arguments).join(" ");
			}
			func(text);
		};
		if (this.rtenv)
			this.rtenv.print = print;
		stdout = print;
	};

	Engine.prototype.setStderrFunc = function(func) {
		var printErr = function(text) {
			if (arguments.length > 1)
				text = Array.prototype.slice.call(arguments).join(" ");
			func(text);
		};
		if (this.rtenv)
			this.rtenv.printErr = printErr;
		stderr = printErr;
	};

	Engine.prototype.setOnExecute = function(onExecute) {
		if (this.rtenv)
			this.rtenv.onExecute = onExecute;
		this.onExecute = onExecute;
	}

	Engine.prototype.setOnExit = function(onExit) {
		this.onExit = onExit;
	}

	Engine.prototype.copyToFS = function(path, buffer) {
		if (this.rtenv == null) {
			throw new Error("Engine must be inited before copying files");
		}
		this.rtenv['copyToFS'](path, buffer);
	}

	// Closure compiler exported engine methods.
	/** @export */
	Engine['isWebGLAvailable'] = Utils.isWebGLAvailable;
	Engine['load'] = load;
	Engine['unload'] = unload;
	Engine.prototype['init'] = Engine.prototype.init;
	Engine.prototype['preloadFile'] = Engine.prototype.preloadFile;
	Engine.prototype['start'] = Engine.prototype.start;
	Engine.prototype['startGame'] = Engine.prototype.startGame;
	Engine.prototype['setWebAssemblyFilenameExtension'] = Engine.prototype.setWebAssemblyFilenameExtension;
	Engine.prototype['setUnloadAfterInit'] = Engine.prototype.setUnloadAfterInit;
	Engine.prototype['setCanvas'] = Engine.prototype.setCanvas;
	Engine.prototype['setCanvasResizedOnStart'] = Engine.prototype.setCanvasResizedOnStart;
	Engine.prototype['setLocale'] = Engine.prototype.setLocale;
	Engine.prototype['setExecutableName'] = Engine.prototype.setExecutableName;
	Engine.prototype['setProgressFunc'] = Engine.prototype.setProgressFunc;
	Engine.prototype['setStdoutFunc'] = Engine.prototype.setStdoutFunc;
	Engine.prototype['setStderrFunc'] = Engine.prototype.setStderrFunc;
	Engine.prototype['setOnExecute'] = Engine.prototype.setOnExecute;
	Engine.prototype['setOnExit'] = Engine.prototype.setOnExit;
	Engine.prototype['copyToFS'] = Engine.prototype.copyToFS;
	return Engine;
})();
