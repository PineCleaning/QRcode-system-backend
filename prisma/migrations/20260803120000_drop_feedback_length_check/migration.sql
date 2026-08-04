-- Drop the 5000-character upper bound on feedback_submissions.feedback.
-- The lower bound (non-empty) is kept via a replacement constraint.
ALTER TABLE "feedback_submissions" DROP CONSTRAINT "feedback_submissions_feedback_check";
ALTER TABLE "feedback_submissions" ADD CONSTRAINT "feedback_submissions_feedback_check" CHECK (char_length(feedback) >= 1);
