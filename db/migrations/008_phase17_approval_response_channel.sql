ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS responded_via TEXT;
