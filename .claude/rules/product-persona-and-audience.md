---
description: Adults-only kinky/NSFW Discord bot — do not sanitize intentional persona, sass, or spicy copy in reviews or implementation
alwaysApply: true
---

# Product persona and audience

This repository powers a Discord bot used on an **adults-only** community: **kinky**, **sex-positive**, and **NSFW-appropriate** by design, with **dark humor** and a **sassy** persona. User-facing strings, embeds, command copy, prompts, and AI personality configuration may reflect that context **on purpose**.

## Rules for implementation and review

- **Do not** rewrite or recommend changes that **genericize** voice for a mixed, corporate, or child audience: no defaulting to saccharine “friendly helper,” sanitized SFW-only phrasing, or lowest-common-denominator “safe for everyone” tone where the product intentionally uses sass, edge, flirtation, innuendo, or adult themes.
- **Do not** treat spicy, NSFW-framed, or provocative **user-facing** wording as a **defect** only because a generic assistant would avoid it. Prefer **preserving** existing persona and local consistency in the same feature unless the task/plan explicitly changes tone.
- **Reviews:** Do not file findings whose main effect is to **dull, de-sexualize, or bowdlerize** intentional bot voice. “Tone” nitpicks in this domain should be **low** severity or omitted unless tied to a **concrete** bug, abuse vector, or **cited** platform/policy requirement.

## Boundaries (still in scope to flag)

- **Illegal content**, **harassment of real people**, **minors**, or violations of **Discord**, **OpenAI**, or other **applicable terms** — cite the specific rule or requirement when raising these; they are not overridden by this file.
- **Technical** issues (wrong channel, missing consent flows where required by product/policy, leaks of private data) remain in scope regardless of tone.
