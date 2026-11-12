# Recipe OCR evaluation: real handwritten pages

This note records what was actually measured on the three photographed recipe pages supplied with the
recipe-scan work, so the feature's claims match its evidence.

## Corpus

| Page | Content | Size |
| --- | --- | --- |
| `revani-indokarydo` | Ρεβάνι με ινδοκάρυδο: one recipe plus a second `Χιονάτες` section | 1500 × 2000 JPEG |
| `tsourekia-and-kourou` | Τσουρέκια Λαμπριάτικα and Τιροπιάκια κουρού μερέντα: two recipes on one page | 1500 × 2000 JPEG |
| `arapina-niki` | Αραπίνα Νίκη: one recipe with a long method | 1500 × 2000 JPEG |

All three are 1980s Greek diary pages written in blue ballpoint on cream ruled paper, photographed
hand-held with the printed hour gutter, weekday/month headings and week-number grids visible.

## Method

`scripts/ocr-benchmark.mjs` runs the real engine and the real preprocessing, not a simulation:

- Tesseract.js 7.0.0, `ell` and `eng` trained data (the same models the browser ships).
- Four image variants: the untouched photo, the straightened page, the paper-cropped page, and the
  minimum-channel ink variant.
- Two page-segmentation modes per run (`SINGLE_COLUMN`, `SPARSE_TEXT`); the longer reading is scored.
- Keyword recall against words that are unambiguously visible on each page (18, 21 and 15 words —
  54 in total). Matching ignores accents, case and punctuation, so a near miss counts if the word is
  there at all.

The image path was verified before trusting the numbers: an initial run decoded the BMP with the wrong
channel order and fed the engine an upside-down page. That run was discarded; the numbers below come
from a re-run whose decode/encode round-trip was checked against `sips`. This is also why the report
quotes exact output text: the conclusion must survive a spot check.

Run it with:

```sh
node --import tsx scripts/ocr-benchmark.mjs data/ocrbench/manifest.json --json data/ocrbench/results.json
```

## Result

**2 of 54 words were recovered (3.7 %), and both hits are the same word `νερό` sitting inside
unrelated OCR noise. No title, ingredient name, unit or cooking verb was read correctly**, in any of
the 24 configurations.

| Variant | Language | Keywords | Mean confidence | Output chars (3 pages) | Time/page |
| --- | --- | --- | --- | --- | --- |
| photo, grayscale | ell | 0/54 | 38 | 4.8 kB | 6.4 s |
| photo, grayscale | eng | 0/54 | 46 | 4.9 kB | 6.6 s |
| page straightened, grayscale | ell | 0/54 | 38 | 4.8 kB | 6.3 s |
| page straightened, grayscale | eng | 0/54 | 46 | 4.9 kB | 6.6 s |
| page cropped | ell | 2/54 | 42 | 4.8 kB | 8.3 s |
| page cropped | eng | 0/54 | 49 | 4.5 kB | 8.6 s |
| page cropped, ink | ell | 1/54 | 43 | 4.0 kB | 8.4 s |
| page cropped, ink | eng | 0/54 | 49 | 4.1 kB | 8.8 s |

The engine reads the *printed* parts of the page and turns the handwriting into nonsense:

- Greek model, cropped page, revani: `Θεοδώρου Του Στροτηλστου. Ζοχαρίου προφ,` (the printed saint
  line, mostly right), then `εν μον ατηπνοικοπννν υυισή` for the title `Ρεβάνι με ινδοκάρυδο`.
- English model, same page: `©eodwpou Tou $1pOTNAGTOU, ZOXapIoU NEY` — it transliterates the printed
  Greek header, then `[¢] de bia Ko 2 pou Vv Epo` for the ingredients.
- The Greek output contains no word longer than four characters that occurs in the recipe.

Confidence is misleading: the English model reports **49–55 % confidence** while producing only
transliterated headers and punctuation. Any UI or test that treats `data.confidence` as a quality
signal is wrong for handwriting; the scanner's character-shape heuristic is also only a warning, not a measure of correctness.

The end-to-end local path is equally unusable. Feeding the best real reading (`page-cropped`, `ell`)
through `cleanNotebookText` and `heuristicRecipes` gives:

| Page | Title read | Parsed ingredients | Parsed steps |
| --- | --- | --- | --- |
| revani | `ἕ.ν.α..οώῤή.ν` | 7 (all noise) | 6 |
| tsourekia | `ΕΑΝ ' Ἵ ΦΕΒΡΟΥΑΡΙΟΣ / ΕΕΒΒυΑΠΡΥ` | 10 (all noise) | 1 |
| arapina | `Μες ὃν Ίο ἰ` | 5 (all noise) | 3 |

The local parser still found quantity-shaped rows, because the planner grid is full of numbers, but
every ingredient name is nonsense. A user who saves one of these drafts gets a broken recipe.

## Secondary finding: the scanner crashed on large pages

A 2400 × 3200 page (the previous upscale target) aborts the Tesseract.js worker in Node with
`RangeError: Too many properties to enumerate`; 2000 × 2667 works. The scanner now caps recipe
recognition at 2000 px wide and 5.5 Mpx (`MAX_RECIPE_OCR_PIXELS`), which is above the 3 Mpx of a
1500 × 2000 phone photo.

## What the implementation does about it

1. **The photo goes to the vision model first.** On-device OCR stays as the private, no-upload path,
   but when an AI provider is configured the photo is sent with the text and the model is told the
   photo is the primary source and the OCR text may be nonsense. A text-only model is detected when
   the provider rejects the image; the request is retried without it and the UI explains that
   handwriting needs a vision model.
2. **Language comes from the page, not the UI.** Greek and English models load together. A Greek
   notebook is read in Greek on an English interface, and `detectScript` reports the measured script.
3. **Cleanup is non-destructive.** Only printed diary furniture, the hour gutter and immediately
   repeated rows are removed. Each removal is reported; the raw reading stays in the UI behind
   **Raw OCR text (before cleanup)** and can be restored with one click. Rows that begin with an
   amount are never treated as planner furniture.
4. **Multiple recipes stay separate.** A short capitalised title followed by an amount row starts a
   new section; the AI prompt returns `recipes[]`. The scan response carries one draft per recipe and
   the page shows them as separate choices. Nothing is merged into a single ingredient list.

## Limitations of this evidence

- The vision-model path was exercised against a mock OpenAI-compatible server (request shape, image
  parts, text-only retry, multi-recipe response), **not** against a real vision model: this
  environment has no AI provider or API key configured. Accuracy of a real vision model on these three
  pages is therefore **not measured**. The contract is tested; the recognition quality is not.
- Apple Vision was not available in this environment (Xcode licence not accepted), so there is no
  independent on-device baseline beyond Tesseract.
- Keyword recall measures whether the right words appear, not full transcription accuracy. Since the
  result is zero, that distinction does not affect the conclusion.
- The photos are personal family recipes and are not committed; the benchmark reads them from a
  manifest kept outside version control.

## OpenRouter one-photo observations

These are **single-photo observations reported by the maintainer while testing OpenRouter**, not a
controlled benchmark. Each model read one photographed page; there is no ground-truth transcript and
no repeated run, so they show which models looked promising and which failed, not an accuracy score.
Costs are the amounts OpenRouter reported for that one scan and will change with model versions,
routing, prompt length and image size.

| Model | Reported cost for one scan | Observation |
| --- | --- | --- |
| Gemini 3 Flash Preview | $0.001557 | Read the key ingredient quantities correctly. |
| Gemini 3.8 Flash | $0.002104 | Read the key ingredient quantities correctly. |
| Gemini 2.5 Flash | $0.00119 | Misread a `2` as `9` in an ingredient quantity. |
| Gemini 2.5 Flash Lite | $0.0001895 | Misread a `2` as `9` in an ingredient quantity. |
| Qwen3.7 | — | Request failed with HTTP 429 (rate limited); no reading. |
| Qwen3.6 35B | — | Needed reasoning disabled. With reasoning on it consumed the whole 8192-token answer budget and returned no content. |

The cheapest readings were also the ones that got a digit wrong. A wrong digit in a quantity is worse
than a slightly higher price, so **do not choose a recipe-scan model on cost alone**. Two models read
the quantities correctly, but that is one photo each and does not establish accuracy on other pages.

### What the implementation does about reasoning

Reasoning ("thinking") models behave differently: some read handwriting better with thinking on,
while hybrid models such as Qwen3 can spend the entire output budget thinking and return nothing. The
right setting is therefore a per-house choice rather than a hard-coded provider:

- **Settings → AI → Recipe reasoning** stores `auto`, `off`, `low`, `medium` or `high` for recipe
  scans only. `auto` (the default) sends no reasoning field and leaves the model's own default in
  place. Nothing is forced on existing installs and receipt scans, ideas and cleanup are unaffected.
- The value is sent to OpenRouter as its `reasoning` request field. If another OpenAI-compatible
  endpoint rejects the field, the request is retried without it and the scan response says so.
- A response that contains only hidden reasoning, or that hits the token limit before any text, is
  retried once with reasoning disabled. The scan response carries a plain-language warning, and the
  AI call log records `finishReason`, `reasoningTokens` and the retry note. If the retry also fails,
  the locally parsed draft is kept with a warning instead of showing an empty recipe.
- A truncated answer is treated as an objective failure: the next model in the chain is tried. If no
  model finishes the page, a truncated answer that still parses as JSON is kept with a warning that the
  recipe may be incomplete.

These mechanisms are covered by tests against a mock provider. They were **not** exercised against a
live OpenRouter key in this environment, so the reasoning-only recovery is verified as a contract, not
as a measured provider behaviour. OpenRouter's `reasoning` support and each model's effort mapping can
change; the setting is a user choice, not a guarantee.

## Fallback chain for recipe photos

A single vision model can fail for reasons unrelated to the photo: a provider error, a rate limit, an
empty answer, hidden reasoning that consumes the whole output budget, or a truncated JSON body. Recipe
scans therefore keep an ordered list of **at most four** models and move to the next one only when the
previous attempt **failed**. A successful answer is returned unchanged — a later model is never billed
just because its reading might be subjectively nicer. That would double the cost and make the result
depend on which model happened to score better on one photo. Truncation is treated as a failure because
it is objective, not subjective; when every model truncates, the last usable partial recipe is kept with
a warning instead of showing an empty draft.

The built-in default is OpenRouter-only, because the IDs below are OpenRouter IDs:

| Order | Model | Why it is in the chain |
| --- | --- | --- |
| 1 | `google/gemini-3-flash-preview` | Read the key quantities correctly; cheapest correct reading above. |
| 2 | `qwen/qwen3.6-35b-a3b` | Different vendor, reads the page; needs reasoning disabled, which the chain sets for this model. |
| 3 | `google/gemini-3.8-flash` | Read the key quantities correctly as a third opinion. |

The cheaper Gemini 2.5 models are deliberately absent: they misread a `2` as a `9`. Qwen3.7 is absent
because the one observation was HTTP 429. This ordering is a **starting point from one-photo
observations**, not a measured accuracy ranking; the benchmark below is how to replace it with evidence
for your own pages.

Rules:

- **Other providers are left alone.** OpenAI, Ollama, LM Studio and any other OpenAI-compatible
  endpoint only receive the model configured in **Settings → AI**. The default chain is never sent
  there, so a house is never charged for an unknown model ID.
- **A configured vision model stays first.** On OpenRouter, an explicitly chosen vision model is tried
  before the defaults, so an existing successful scan behaves exactly as before; the defaults only run
  after a failure.
- **Settings → AI → Recipe vision models** accepts a comma-separated list of up to four IDs and is
  honoured on any endpoint. Listing only one model opts out of extra fallbacks. The server-side
  equivalent is `OPENAI_RECIPE_VISION_MODELS`.
- **All costs are counted.** The response's `aiCost`, the scan badge and the AI call log include every
  attempt, including a reasoning retry that failed. Each attempt is a separate row in the AI call log
  with `visionChain`, `visionIndex` and `visionModel` metadata. A `null` price means at least one attempt
  that reported usage did not report a price, so a full sum cannot be shown; provider errors that
  returned no usage are not counted either.
- **Warnings say which model failed and why.** The scan keeps the locally parsed draft when every model
  fails, names each failed model in the warning, and shows the winning model on the review card.
- The image-rejection retry still exists: if every model rejects the photo, the text is retried once
  without the image and the UI explains that handwriting needs a vision model.

Model IDs and availability change. If OpenRouter retires one of the defaults, that attempt fails and
the chain moves on with a warning; replace the list in **Settings → AI** if it happens often. The chain,
cost accounting and warnings in this environment are covered by tests against a mock provider. No live
OpenRouter key was available here, so the specific default IDs and their current availability are not
verified.

## Developer benchmark: comparing model IDs

`scripts/recipe-vision-benchmark.mjs` compares user-supplied model IDs on real photos with the **same**
prompt, schema, temperature and `max_tokens` as the scanner. It is manual (it needs photos, a key and
money), so it is not part of `npm test`.

```sh
OPENAI_API_KEY=... node --import tsx scripts/recipe-vision-benchmark.mjs \
  data/recipe-vision/manifest.json --json data/recipe-vision/results.json
```

The manifest names photos by **path**; the key is read from `OPENAI_API_KEY`, and the validator rejects
API keys, tokens, passwords, credentials embedded in the base URL, inline base64 and image data inside
the manifest. Keep the manifest and photos outside version control — the script warns if a photo lives
inside the repository. Photos are only read and sent to the provider; they are never copied into the
report.

```json
{
  "baseUrl": "https://openrouter.ai/api/v1",
  "models": ["google/gemini-3-flash-preview", "qwen/qwen3.6-35b-a3b"],
  "referenceModel": "google/gemini-3-flash-preview",
  "reasoning": "auto",
  "images": [
    {
      "path": "../private-photos/revani.jpg",
      "label": "revani",
      "truth": {
        "title": "Ρεβάνι με ινδοκάρυδο",
        "ingredients": [{ "name": "βούτυρο", "quantity": 160, "unit": "γραμμ." }],
        "steps": ["Χτυπάμε το βούτυρο με τη ζάχαρη."]
      }
    }
  ]
}
```

Every image must have a written `truth` or a `referenceModel` that is also measured on the same photos,
so a score always has an explicit basis:

- **Truth score** compares title, ingredient names (F1 against invented rows), exact quantities, units
  through a Greek/English synonym table and step word coverage. Matching ignores accents, case and
  punctuation. Weights are exported as `RECIPE_SCORE_WEIGHTS` in `shared/recipe-vision-score.ts`.
- **Reference score** is similarity to the named model's answer. It is **not accuracy**: a model that
  copies the reference's wrong `2` as a `9` scores highly. Use it only when no transcript exists.
- The report prints per-model mean truth score, mean reference score, cost (provider-reported cost
  first, then explicit prices), tokens and failures, and writes the same data as JSON without any image
  bytes. Models are ordered by truth score, then cost. Limits are four models and eight photos per run
  to keep an accidental run affordable.

Limitations: the benchmark mirrors the production request but runs outside the server, so it does not
exercise the app's logging, budget guard or fallback chain. It scores the first recipe when a page holds
several. One photo per model still does not establish accuracy on other pages.
