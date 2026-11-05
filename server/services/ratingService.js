'use strict';
// Average rating and review count for venues (FR#23, SQ#3).
//
// These are always CALCULATED from the reviews table, never stored, so they cannot drift out
// of step with the reviews (a stored copy would have to be updated on every add, edit, delete,
// flag and removal). Only publicly visible reviews count: published and reported ones.
// The average is rounded to one decimal place.

// A static join, used by the venue queries. Joins as alias `r`, giving r.avg_rating and r.review_count.
const RATING_JOIN_SQL =
  "LEFT JOIN (SELECT venue_id, ROUND(AVG(rating)::numeric, 1) AS avg_rating, COUNT(*)::int AS review_count FROM reviews WHERE status IN ('published', 'reported') GROUP BY venue_id) r ON r.venue_id = v.id";

// Database row -> { avgRating: number | null, reviewCount: number }
function ratingFromRow(row) {
  return {
    avgRating:
      row.avg_rating === null || row.avg_rating === undefined ? null : Number(row.avg_rating),
    reviewCount: Number(row.review_count || 0),
  };
}

module.exports = { RATING_JOIN_SQL, ratingFromRow };
