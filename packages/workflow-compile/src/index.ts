import debugModule from "debug";
const debug = debugModule("workflow-compile");
import fse from "fs-extra";
import { prepareConfig } from "./utils";
import { Shims, Compilation } from "@truffle/compile-common";
import { getTruffleDb } from "@truffle/db-loader";
import { Plugins } from "@truffle/plugins";

// check if the compiler plugin is new fomrat: array of objects
const isPluginNewFormat = async (config, plugin) => {
  if (typeof plugin === "object") {
    if (plugin.hasOwnProperty("compiler")) {
      for (const key in config.compilers) {
        const compiler = config.compilers[key];
        if (
          compiler.hasOwnProperty("plugin") &&
          compiler["plugin"] === plugin.name
        ) {
          return typeof plugin;
        }
      }
    }
  } else if (typeof plugin === "string") {
    for (const key in config.compilers) {
      const compiler = config.compilers[key];
      if (compiler.hasOwnProperty("plugin") && compiler["plugin"] === plugin) {
        return typeof plugin;
      }
    }
  }
  return false;
};

// compilers array contains plugin compilers only
const pluginCompilers = async (config, compilers) => {
  for (let j = compilers.length - 1; j >= 0; j--) {
    let isPlugin = false;
    for (const plugin of config.plugins) {
      const pluginFormat = await isPluginNewFormat(config, plugin);
      if ("object" === pluginFormat && plugin.compiler === compilers[j]) {
        // object format
        isPlugin = true;
        break;
      } else if (
        "string" === pluginFormat &&
        plugin === config.compilers[compilers[j]].plugin
      ) {
        // string format
        isPlugin = true;
        break;
      }
    }

    // if not a plugin compiler, remove from compilers
    if (!isPlugin) {
      compilers.splice(j, 1);
    }
  }
};

const checkForCompilerPlugin = async (config, name) => {
  let pluginCompiler = config.plugins ? config.plugins : null;

  if (pluginCompiler) {
    for (const plugin of config.plugins) {
      const pluginFormat = await isPluginNewFormat(config, plugin);
      if ("object" === pluginFormat) {
        // if plugin is an object, then pass compiler name as input to Plugins.compile()
        // save config.plugins
        let currentPlugins = config.plugins;
        let newPlugins: string[] = [];

        if (plugin.hasOwnProperty("compiler") && plugin.compiler === name) {
          newPlugins.push(plugin.name);
        }

        config.plugins = newPlugins;
        pluginCompiler = Plugins.compile(config);
        // restore config.plugins
        config.plugins = currentPlugins;
        return pluginCompiler;
      } else if ("string" === pluginFormat) {
        // plugin fomrat is string
        let currentPlugins = config.plugins;
        let newPlugins: string[] = [plugin];
        config.plugins = newPlugins;
        pluginCompiler = Plugins.compile(config);
        // restore config.plugins
        config.plugins = currentPlugins;
        return pluginCompiler;
      }
    }
  }
};

const SUPPORTED_COMPILERS = {
  solc: require("@truffle/compile-solidity").Compile,
  vyper: require("@truffle/compile-vyper").Compile,
  external: require("@truffle/external-compile").Compile
};

async function compile(config) {
  // determine compiler(s) to use
  let compilers = config.compiler
    ? config.compiler === "none"
      ? []
      : [config.compiler]
    : Object.keys(config.compilers);

  // for a complier plugin, need to remove default compilers (solc and vyper) from compilers array
  if (config.plugins) {
    await pluginCompilers(config, compilers);
  }

  // invoke compilers
  const rawCompilations = await Promise.all(
    compilers.map(async name => {
      // NEED PLUGIN COMPILER TO BE IN SUPPORTED_COMPILERS
      let Compile = SUPPORTED_COMPILERS[name];
      const pluginCompile = await checkForCompilerPlugin(config, name);
      // shall we support multiple compiler plugins?
      if (pluginCompile[0].module === config.compilers[name].plugin) {
        Compile = pluginCompile[0].loadCompiler();
      }

      if (!Compile && !pluginCompile)
        throw new Error("Unsupported compiler: " + name);

      if (config.all === true || config.compileAll === true) {
        return await Compile.all(config);
      } else if (Array.isArray(config.paths) && config.paths.length > 0) {
        // compile only user specified sources
        //NEED THESE METHODS TO EXIST WITHIN THE PLUGIN COMPILER
        return await Compile.sourcesWithDependencies({
          options: config,
          paths: config.paths
        });
      } else {
        return await Compile.necessary(config);
      }
    })
  );

  // collect results - rawCompilations is CompilerResult[]
  // flatten the array and remove compilations without results
  const compilations = rawCompilations.reduce((a, compilerResult) => {
    compilerResult.compilations.forEach((compilation: Compilation) => {
      if (compilation.contracts.length > 0) {
        a = a.concat(compilation);
      }
    });
    return a;
  }, []);

  // collect together contracts as well as compilations
  const contracts = rawCompilations.flatMap(
    compilerResult => compilerResult.contracts
  );

  // return WorkflowCompileResult
  return { contracts, compilations };
}

export default {
  async compile(options) {
    const config = prepareConfig(options);

    if (config.events) config.events.emit("compile:start");

    const { contracts, compilations } = await compile(config);

    const compilers = compilations
      .reduce((a, compilation) => {
        return a.concat(compilation.compiler);
      }, [])
      .filter(compiler => compiler);

    if (contracts.length === 0 && config.events) {
      if (config.compileNone || config["compile-none"]) {
        config.events.emit("compile:skipped");
      } else {
        config.events.emit("compile:nothingToCompile");
      }
    }

    const result = { contracts, compilations };

    if (config.events) {
      await config.events.emit("compile:succeed", {
        contractsBuildDirectory: config.contracts_build_directory,
        compilers,
        result
      });
    }

    return result;
  },

  async compileAndSave(options) {
    const { contracts, compilations } = await this.compile(options);

    return await this.save(options, { contracts, compilations });
  },

  async save(options, { contracts, compilations }) {
    const config = prepareConfig(options);

    await fse.ensureDir(config.contracts_build_directory);

    if (options.db && options.db.enabled === true && contracts.length > 0) {
      // currently if Truffle Db fails to load, getTruffleDb returns `null`
      const Db = getTruffleDb();

      if (Db) {
        debug("saving to @truffle/db");
        const db = Db.connect(config.db);
        const project = await Db.Project.initialize({
          db,
          project: {
            directory: config.working_directory
          }
        });
        ({ contracts, compilations } = await project.loadCompile({
          result: { contracts, compilations }
        }));
      }
    }

    const artifacts = contracts.map(Shims.NewToLegacy.forContract);
    await config.artifactor.saveAll(artifacts);

    return { contracts, compilations };
  },

  async assignNames(options, { contracts }) {
    // currently if Truffle Db fails to load, getTruffleDb returns `null`
    const Db = getTruffleDb();

    const config = prepareConfig(options);

    if (!Db || !config.db || !config.db.enabled || contracts.length === 0) {
      return;
    }

    const db = Db.connect(config.db);
    const project = await Db.Project.initialize({
      db,
      project: {
        directory: config.working_directory
      }
    });

    await project.assignNames({
      assignments: {
        contracts: contracts.map(({ db: { contract } }) => contract)
      }
    });
  }
};
