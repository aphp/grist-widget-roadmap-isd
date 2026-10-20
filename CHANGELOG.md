# Changelog

## Unreleased

- Team: optional `Team.aph` column (APH id) read and shown in the Team tab rows and the person card. It can be edited
  in the person form and on creation only once it is a data column in Grist; while it is the empty formula column of
  the Feuille, the field stays read-only with its reason. Strict check in the writer: 1 to 10 digits, or empty.
- Charges: the person whose APH is `9999999` (`ESTIMATION_APH`, used to estimate load in the roadmap) is the only
  one exempt from the "1 FTE maximum per person" rule, in the form and in the writer; a sanity bound of 50 FTE over
  the period (2,000 h without dates) still applies. An "Estimation" badge explains it next to that person.
- Dev: `?ecritures=aph-donnee` makes `Team.aph` a data column (with the synthetic dataset: invented APHs and an
  "Estimation DE" person).

## [0.2.0] — 2026-10-20
First published version.

- Read views: Kanban, Table, Gantt, Portfolio (load per person), Statistics (including the load plan and the data to
  complete), Summary, Team; filters, "Je suis…" (who am I), detail panel, CSV and PDF exports.
- "Mes tâches" (my tasks) tab grouped by due period, weekly load banner, start view per profile.
- Load in FTE (1 FTE = 35 h per week of the task), split by profile PO, DA, DS, DE, Mgmt, Other.
- Editing (off by default, `?edition=essai` or `?edition=1&doc=<id>`, `flags.json` kill switch):
  - tasks and sub-tasks, "Personnes" block (assignees and load in FTE or hours);
  - chantiers (workstreams), creation ("Nouvelle tâche", "Nouveau chantier", "Sous-tâche"), moving a task to another
    chantier;
  - ISD team: add, edit, deactivate, unavailability periods.
- Grist plugin API and DSFR 1.15.3 served locally (no CDN request at startup).
