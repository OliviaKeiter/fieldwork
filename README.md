# Fieldwork

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/OliviaKeiter/fieldwork)

Fieldwork is a self-hosted, single-user job-search cockpit. It replaces the spreadsheet, the sticky notes, and the "did I ever follow up with them?" anxiety with one app: a pipeline kanban, a daily action queue computed from your own timing rules, an AI scorecard and intake flow with optional web sourcing, a resume studio (two layouts, six color themes, docx/PDF export), interview prep docs, outreach drafts, an insights view built from your lessons-learned log, and a full data export so your data can always walk out the door. Built on Astro + React + Tailwind + Supabase + Claude.

## Features

- **Today queue**: everything due today, one card each, one button each. Follow-up nudges, thank-yous, and ghost detection are computed from configurable timing rules.
- **Pipeline board**: kanban by status (to_apply through offer/rejected/ghosted), drag to move, aging badges. Dragging to Rejected asks for the stated reason and logs a lessons row automatically.
- **Intake + scorecard**: paste a JD (or URL). An edge function checks liveness, extracts comp/location/requirements, and returns a verdict card scored against your career record.
- **Daily loop**: optional web sourcing (via Tavily) finds new roles matching your target titles, dedupes against your pipeline, and scorecards each one.
- **Resume studio**: two layouts in six color themes, certifications and clearance, ATS keyword pass, in-browser .docx and PDF export. Every line is bounded by your career record; the AI can rephrase it but never exceed it, and every exported version is kept.
- **Interview prep**: per-round prep docs generated from the stored JD, your record, and your lessons log. Debrief forms feed thank-you drafts.
- **Outreach drafts**: hello / nudge / thank-you / stay-in-touch / cover letter. Drafts only. The app never sends anything; you get Copy and Mark Sent buttons.
- **Insights**: KPI tiles, funnel, stage conversion, effectiveness by source/title/grade, deaths-by-stage, clustered rejection reasons, title win-rates, and weekly velocity — with panels you can reorder or hide.
- **Data export**: csv/markdown export of everything.

## Screenshots

_Coming soon._

## Design principles

- **Single-user by design.** One profile per Supabase project, and the schema enforces it: the first account to sign in claims the project, and every table is readable only by that owner (see [Security](#security)). Spin up your own project; it's free-tier friendly.
- **The career record is the ceiling.** Every AI action reads your record from the database and nothing generated may exceed it.
- **Drafts are never auto-sent.** Every outbound artifact ends at a Copy button. The human clicks send.
- **No em dashes ever.** House style, enforced in every AI prompt.

## Setup (self-hosting)

Two ways to run Fieldwork, both single-user and self-hosted:

- **[Fully local](#run-fully-locally-data-never-leaves-your-machine)** — the database runs in Docker on your own machine and your pipeline never leaves it. Best for privacy. The only thing that goes out is the AI calls (to Anthropic); that is inherent to an AI app.
- **Hosted Supabase** (below) — a free cloud Supabase project holds your data. Simpler to stand up, and lets you reach the app from more than one device.

The steps below cover the hosted path; the local path reuses most of them and is spelled out in its own section.

You need: an Anthropic API key, Node 22.12 or newer (Astro 7 requires it; `npm install` will refuse an older runtime), and either a free [Supabase](https://supabase.com) account (hosted) or [Docker](https://docs.docker.com/get-docker/) + the [Supabase CLI](https://supabase.com/docs/guides/cli) (local).

### 1. Create a Supabase project and run the schema

Create a new Supabase project, open the SQL editor, and run the contents of [`supabase/schema.sql`](supabase/schema.sql). This creates the 12 `fw_` tables, 7 enums, the owner-scoped row-level security policies, and default settings.

### 2. Enable email auth and allow your redirect URLs

In Supabase Auth settings, enable the Email provider (magic link). Fieldwork signs in with a magic link; no passwords.

Then, under **Auth > URL Configuration**, add every URL you will sign in from to the redirect allow-list:

- `http://localhost:4321/**` — the Astro dev server's port. Do this even if you only ever run locally.
- `https://your-site.netlify.app/**` — once you deploy (step 6).

This matters more than it looks. Fieldwork asks Supabase to send you back to `/today` on the origin you signed in from. If that origin is not on the allow-list, Supabase silently ignores it and uses the project's Site URL instead (which defaults to `http://localhost:3000`), so your magic link lands on a dead page. If a link ever drops you somewhere unexpected, this is why.

### 3. Deploy the edge functions

Install the [Supabase CLI](https://supabase.com/docs/guides/cli), then link this repo to your project. `supabase link` needs a `config.toml`, which `supabase init` creates:

```sh
supabase login
supabase init                            # creates supabase/config.toml
supabase link --project-ref <your-ref>   # the ref is in your project's dashboard URL
```

Then deploy all six functions:

```sh
supabase functions deploy scorecard
supabase functions deploy daily_loop
supabase functions deploy draft
supabase functions deploy prep
supabase functions deploy resume_content
supabase functions deploy sweep
```

(If you would rather not link, append `--project-ref <your-ref>` to each deploy instead.)

### 4. Set function secrets

```sh
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...   # required, from console.anthropic.com
supabase secrets set TAVILY_API_KEY=tvly-...        # optional, enables web sourcing in daily_loop; free tier at tavily.com
```

### 5. Configure the app

```sh
cd app
cp .env.example .env
```

Fill in your Supabase project URL and anon (publishable) key from the project's API settings.

### 6. Run locally or deploy

Local:

```sh
cd app
npm install
npm run dev
```

The app runs at `http://localhost:4321`.

Or use the launcher in the repo root: double-click `launch.cmd` on Windows, or run `./launch.sh` on macOS/Linux. First run installs dependencies and creates `app/.env` for you to fill in; after that it starts the server and opens the app.

Or deploy to Netlify. The fastest way is the **Deploy to Netlify** button at the top of this README: it clones this repo to your GitHub account, prompts you for `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY`, and deploys (the committed root [`netlify.toml`](netlify.toml) sets the base directory and build for you). The button only deploys the app itself — steps 1 through 4 (schema, auth, edge functions, secrets) are still yours to do, and can happen before or after.

To wire it up by hand instead: create a Netlify site from your fork, set the base directory to `app`, and add the same two environment variables. The committed [`app/netlify.toml`](app/netlify.toml) declares the build command and publish directory (both relative to that base), so leave those fields alone.

Either way, finish by adding your deployed URL to the redirect allow-list from step 2, or your magic links will land on a dead page.

### 7. First sign-in

Sign in with your email. You land on Today, which will be empty.

Now build your career record: go to **Settings > Open onboarding wizard** and work through the setup interview (or upload an existing resume in Settings and let it extract one). The wizard is reached through Settings rather than the sidebar, since it is a one-time thing. The career record is the foundation everything else is scored against, so it's worth doing properly.

## Security

Your pipeline holds real names, real contacts, and where you're interviewing. Two things keep it private, and it's worth understanding both:

- **Nothing is readable without a session.** The Supabase anon key that ships in the browser bundle is meant to be public; on its own it reads nothing, because every table has row-level security and no policy grants the anonymous role access. (Verified: an anonymous request sees zero rows.)
- **Only the owner can read, even among signed-in users.** RLS is not "any logged-in user" — it's scoped to one owner. The first account to sign in to a fresh project claims it (via the `fw_claim_owner` function the app calls on login); every account after that is locked out at the database, and ownership can't be reassigned by a later signup. So even if you leave Supabase's default email signups on and a stranger signs in with their own address, they see nothing.

That second point is the important one, because a new Supabase project **does** allow email signups by default. Owner-scoping means you're safe without having to remember to turn that off — but turning it off is still good hygiene once you've signed in for the first time (Supabase dashboard → Authentication → Providers → Email → disable "Allow new users to sign up"). Do it *after* your first login, or you'll lock yourself out before you can claim ownership.

One caveat if you don't use a dedicated project: this scopes access to a single owner within one project, but it does not isolate Fieldwork from *other* apps you run in the same Supabase project. The design assumes one project per person. If you share a project across apps, an owner of a different app there is still a distinct account and won't see your pipeline — but you're relying on that separation rather than on a hard boundary. A dedicated project is cleanest.

## Run fully locally (data never leaves your machine)

This runs the entire backend — Postgres, auth, and the edge functions — in Docker on your own machine. Your pipeline, contacts, and resumes stay local. The one exception is the AI features (scorecard, resume, drafts, prep), which call the Anthropic API; there is no offline substitute for the model, so those requests leave your machine and nothing else does.

You need [Docker](https://docs.docker.com/get-docker/) running and the [Supabase CLI](https://supabase.com/docs/guides/cli) installed.

### 1. Start the local stack

```sh
supabase init      # creates supabase/config.toml (first time only)
supabase start     # boots Postgres, Auth, Studio, and the edge runtime in Docker
```

`supabase start` prints a table when it finishes. Keep it — you need the **API URL** (`http://127.0.0.1:54321`), the **anon key**, and the **Studio URL** (`http://127.0.0.1:54323`). You can reprint it anytime with `supabase status`.

### 2. Create the schema

Open the local Studio URL, go to the SQL editor, and run the contents of [`supabase/schema.sql`](supabase/schema.sql) — same file as the hosted path. (Or, if you have `psql`, the local database URL is always `postgresql://postgres:postgres@127.0.0.1:54322/postgres`, so: `psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -f supabase/schema.sql`.)

### 3. Give the edge functions their secrets and serve them

```sh
printf 'ANTHROPIC_API_KEY=sk-ant-...\nTAVILY_API_KEY=tvly-...\n' > supabase/functions/.env   # TAVILY optional
supabase functions serve --env-file supabase/functions/.env
```

Leave that running in its own terminal. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to the functions automatically by the local runtime.

### 4. Point the app at the local stack

```sh
cd app
cp .env.example .env
```

Set `PUBLIC_SUPABASE_URL=http://127.0.0.1:54321` and `PUBLIC_SUPABASE_ANON_KEY` to the anon key from step 1, then:

```sh
npm install
npm run dev
```

### 5. Sign in — the magic link stays local too

Local Supabase does not send real email; it captures it in a local inbox. Request a magic link in the app, then open that inbox in your browser — its URL is printed in the `supabase start` output (usually `http://127.0.0.1:54324`) — find the message, and click the link. The first account you sign in with claims ownership of the project (see [Security](#security)).

To stop everything later: `supabase stop`. Your data persists in Docker between runs.

## Notes

- `SPEC.md` is the original build spec, kept as documentation.
- The sweep function does not fetch mail itself (no OAuth app ships with this repo). It accepts pasted email summaries and classifies them against your pipeline; see the comments in `supabase/functions/sweep/index.ts` for how to wire up real mail fetching.

## Credit

Built by [Olivia Keiter](https://oliviakeiter.com) ([github.com/OliviaKeiter](https://github.com/OliviaKeiter)) with Claude.

## License

[MIT](LICENSE)
