-- Saved viewer marks can be deleted: a revision of action 'delete' marks the item deleted (and hidden). Additive only:
-- the check gains one value; no row, column or earlier revision changes, and a deleted item's revisions all stay.
BEGIN;
ALTER TABLE "ViewerRevision" DROP CONSTRAINT "ViewerRevision_action_check";
ALTER TABLE "ViewerRevision" ADD CONSTRAINT "ViewerRevision_action_check" CHECK ("action" IN ('create','edit','hide','restore','delete'));
COMMIT;
