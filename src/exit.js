// Exit codes shared by every command, so scripts and CI can tell "the chain
// has a problem" apart from "the check couldn't run".

export const EXIT = {
  OK: 0, // every check passed
  PROBLEMS: 1, // problems found: tampering, broken links, providers disagree on a finalized block
  INCONCLUSIVE: 2, // compare: only unfinalized disagreements or incomplete results
  ERROR: 3, // couldn't run: bad arguments, unknown command, unreachable node, too few providers
};

export const EXIT_CODES_HELP = `Exit codes:
  0  every check passed
  1  problems found (tampering, broken links, providers disagree on a finalized block)
  2  inconclusive (compare: only unfinalized disagreements or incomplete results)
  3  couldn't run (bad arguments, unknown command, unreachable node, too few providers)`;
