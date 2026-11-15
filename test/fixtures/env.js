// For the tests: prints whether VS Code's "run as Node" switch reached the command.
console.log(`ELECTRON_RUN_AS_NODE=${process.env.ELECTRON_RUN_AS_NODE || "unset"}`);
