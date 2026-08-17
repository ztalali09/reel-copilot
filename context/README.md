# Brand context

The judgement pass is only as good as what you put here. Drop a single file named
`brand.md` in this directory. Everything else in `context/` is git-ignored, because a
useful brand brief tends to carry positioning, tone rules and internal numbers you do not
want in a public repository.

There is no schema. The file is injected verbatim into the prompt, so write it for a
smart new hire rather than for a parser. What actually moves the output quality:

- **Who you are**, in one paragraph, in plain language.
- **Who your audience is** — precise enough that the model can tell when a Reel is *not*
  aimed at them. This is what earns you honest refusals instead of forced comments.
- **The pains you speak to**, and the angle you take on each.
- **Tone rules**, with examples of phrasing you accept and phrasing you reject.
- **Hard prohibitions** — claims you must never make, competitors you never attack,
  features that do not exist yet.
- **Reference comments** you consider good, with a line on *why* each works.

Write the prohibitions as bluntly as you can. A model follows "never say X" far more
reliably than it infers X from a paragraph of positioning.
