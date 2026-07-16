# About Fieldwork

Fieldwork is a job-search cockpit you run for yourself. It replaces the spreadsheet, the sticky notes, and the low background hum of *did I ever follow up with them?* with one place that knows your pipeline, computes what actually needs you today, and drafts the awkward messages so you only have to press send.

It was built for one person's job search and then cleaned up so anyone can run their own copy. There is no shared server, no accounts to manage, no company behind it reading your data. You point it at your own database and it is yours.

## Why it works the way it does

A few decisions shape everything else:

- **Single-user by design.** One person, one database. The schema locks every table to a single owner, claimed the first time you sign in, so your pipeline is closed even if you never touch a setting. Fieldwork was not built to be multi-tenant, and that is the point.
- **Your career record is the ceiling.** Every AI action reads the record you wrote and is not allowed to exceed it. The model can rephrase what is true about you; it cannot invent a job you never had or a number you never hit.
- **Drafts are never sent for you.** Every outbound thing — a nudge, a thank-you, a cover letter — ends at a Copy button. A human decides what leaves. The app is a drafting table, not an outbox.
- **Your data can always walk out the door.** Full CSV and Markdown export of everything, any time. Nothing is locked in.

## What's in it

A pipeline kanban, a daily action queue built from your own timing rules, an AI scorecard and intake flow with optional web sourcing, a resume studio with four templates and in-browser docx/PDF export, per-round interview prep, outreach drafts, and an insights view built from your own lessons-learned log.

## How it's built

Astro, React, and Tailwind on the front; Supabase (Postgres, auth, and edge functions) for the backend; Claude for the AI. It runs against a free hosted Supabase project, or fully locally in Docker so your data never leaves your machine. Setup is in the [README](README.md).

## Who it's for

Anyone running a real job search who would rather have one honest tool than eight browser tabs. You will need to be comfortable spinning up a Supabase project and pasting in an API key — it is self-hosted, not a product you sign up for. If that trade (a little setup, in exchange for your data staying yours) sounds right, it is for you.

Built by [Olivia Keiter](https://oliviakeiter.com) with Claude. [MIT](LICENSE) licensed — fork it, change it, make it yours.
