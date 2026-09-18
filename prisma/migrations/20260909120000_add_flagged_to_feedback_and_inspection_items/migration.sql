-- Flagged Feedback / Flagged Inspection Items (Phase 2, Week 3 Thu).
--
-- Both are manually toggled by an admin/supervisor to mark something as
-- needing follow-up - independent of an inspection item's rating (a
-- supervisor flags something because it's urgent, not because the
-- system inferred it from a low score - confirmed with the user on a
-- real client call, 2026-09-09).

ALTER TABLE "feedback_submissions" ADD COLUMN "flagged" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "feedback_submissions_flagged_idx" ON "feedback_submissions"("flagged");

ALTER TABLE "inspection_items" ADD COLUMN "flagged" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "inspection_items_flagged_idx" ON "inspection_items"("flagged");
