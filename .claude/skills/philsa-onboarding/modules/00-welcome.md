# Module 0 — Welcome & your profile

**Goal:** know who you're teaching and agree on a path. **Time:** ~5 min.

## Read first
- `README.md` (top section and "Status & what's next"). Read it so you can
  give the one-paragraph pitch accurately.

## Open with the pitch (3–4 sentences, no more)

This repo is a proof-of-concept **geospatial data platform** for PhilSA, built
with the World Bank. It catalogs Earth-observation data (Sentinel-1/2 scenes,
derived products like NDVI and a flood proxy, land cover, admin boundaries) on
**open international standards**: STAC for discovery, Cloud-Optimized GeoTIFFs
for pixels, and XYZ tiles for maps. Any agency can then use PhilSA data with
tools they already own. A MapLibre webmap with an AI assistant is the
reference consumer that proves it works. You're taking it over, so this
onboarding covers running it, changing it safely, and *why* it's built this
way.

## Ask (one AskUserQuestion, up to 4 questions)

1. **Background.** Options: GIS / remote sensing · Python / data engineering ·
   web / JavaScript · DevOps / cloud. Multi-select.
2. **What you'll mostly work on.** Options: data pipelines · webmap / frontend
   · deployment & operations · all of it / not sure yet.
3. **Machine.** Options: macOS · Linux · Windows with WSL2 · Windows native.
   Windows native is a warning sign: the shell scripts and GDAL tooling assume
   a Unix shell. Recommend WSL2.
4. **Platforms you have access to or know** (this feeds Module 7). Options:
   Cloudflare / Render / Neon · Azure · on-prem / government data center ·
   other cloud. Multi-select; "Other" lets them name tools like Kubernetes or
   Terraform.

## Then

- **Create `.onboarding/progress.md`** with the profile (format in
  `SKILL.md`). Make sure `.onboarding/` is gitignored. It should already be;
  if not, add it.
- **Recommend a path.** It is always 0 → 1 → 2, then by focus:

  | Focus | After Module 2 |
  |---|---|
  | All / not sure | 3 → 4 → 5 → 6 → 7 → 8 |
  | Pipelines | 3 → 4 → 6 → E1 → 8, then 5 and 7 lightly |
  | Webmap / frontend | 5 → 6 → 3 (skim) → 8, then 4 lightly |
  | Deployment / ops | 5 → 6 → 7 → E2 → 8 |

- **Tell them the deal.** Each module is ~15–30 minutes: essentials, a
  hands-on checkpoint, then a choice to dive deeper, ask anything, or move on.
  They can stop anytime and resume later, because progress is saved.

## Checkpoint
Profile saved and the path agreed. Offer: start Module 1, or (if they're
itching to run something) Module 2 first.
