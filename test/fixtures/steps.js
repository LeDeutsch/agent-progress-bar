// A small command for the tests: prints "step N of 3" lines, one as a progress bar redraw (\r),
// one on stderr, then exits with the code given as first argument.
const code = Number(process.argv[2] || 0);
process.stdout.write("starting\n");
process.stdout.write("step 1 of 3\rstep 2 of 3\n");
process.stderr.write("\x1b[33mwarning: something\x1b[0m\n");
process.stdout.write("step 3 of 3\n");
process.exit(code);
