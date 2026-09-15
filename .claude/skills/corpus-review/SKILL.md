---
name: corpus-review
description: Review a change to the generated vector corpus before it is committed. Use when a diff touches anything under vectors/, when a generator family has been added or changed, or when a pull request rebuilds the corpus. Separates the changes a generator edit should produce from the ones that signal a defect.
---

# Reviewing a corpus diff

A corpus diff is large by construction and unreadable line by line. Reviewing it means
asking a fixed set of questions about its shape, not reading it.

## Establish what should have changed

Before opening the diff, read the generator change and predict:

- which families are affected;
- whether script hashes should move at all.

A hash moving means a script changed. That is correct for a family whose parameters
changed and is a defect anywhere else. Any hash movement outside the families the change
touched is the single highest-signal finding available here, so look for it first.

```
git diff --stat vectors/ | tail -5
git diff vectors/index.json | grep -E '^[-+].*(digest|vectorCount|observationCount)'
```

## The checks

**Observations survived.** `observationCount` in the index must not fall. Chain
observations cannot be recomputed and replacing one costs testnet ADA. A drop means a
rebuild dropped evidence, and that is a blocking finding whatever else is right.

```
git diff vectors/index.json | grep observationCount
```

**No vector was hand-edited.** `npm run vectors:verify` re-derives everything and
reports disagreements. It passing is necessary, not sufficient: also confirm the diff
contains no change to a file the generator change cannot explain.

**Hashes moved only where expected.** Extract the changed script hashes and check every
one falls in an affected family.

```
git diff vectors/ | grep -E '^[-+]\s+"scriptHash"' | sort | uniq -c
```

**Coverage did not silently shrink.** `vectorCount` and `satisfactionCaseCount` falling
is fine when a family was deliberately narrowed and suspicious otherwise. A family
disappearing from `families` is always worth a question.

**New vectors answer a question.** Every family carries a `question`. If a new family's
question is a restatement of its name, the family is not earning its place.

**Degenerate cases are marked.** A vector with an unusual shape should carry a remark
explaining it. An unmarked oddity reads as an accident to the next reader.

## Sampling

Read three vectors in full rather than skimming all of them: the smallest changed, the
largest changed, and one that carries a remark. Check the recorded hash against the CLI:

```
python3 -c "import json;print(json.dumps(json.load(open('vectors/<id>.json'))['script']))" \
  | npx tsx src/cli.ts inspect -
```

## What is not a finding

- A large diff. Regenerating a corpus rewrites every file it touches.
- A changed `generatedAt`. It is a timestamp.
- Reordered satisfaction cases, provided the set is the same.

## Reporting

State findings as: the file or family, what changed, and why the generator change does
not account for it. A finding that cannot name what a rebuild failed to explain is an
observation about diff size, not a review.
