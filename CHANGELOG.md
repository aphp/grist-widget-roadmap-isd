# Changelog

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
