# legacy/

`options-engine-1.1.1.js` is a FROZEN copy of the previous production engine (opt-1.1.1). It is not used for the
published score. During the transition, `engine/pipeline.js` also computes it for every signal and stores
`legacy: { version, finalScore, dir, tier }` in the journal row, so opt-1.2.0 and opt-1.1.1 can be compared on the
SAME observations (`store/evaluation.js` reports the legacy IC next to the new one).

Remove this folder, its import in `engine/pipeline.js` and the `legacy` journal field after ~10 sessions of
resolved data, once the comparison has been read. Never edit the frozen file.
