-- Columns added in place (see 20261012032717_lecture_by_lecture for why tables are
-- never rebuilt here).

-- How many pages or slides a deck has, including ones with no text.
ALTER TABLE "Material" ADD COLUMN "pageCount" INTEGER;

-- What each slide shows, written by a model that saw the slides as images, for the
-- later steps that only read text.
ALTER TABLE "Lecture" ADD COLUMN "slideNotes" TEXT;
