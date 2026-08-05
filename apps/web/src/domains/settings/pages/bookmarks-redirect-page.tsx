import { useEffect } from "react";
import { useNavigate } from "react-router";

import { routes } from "@/utils/routes";

/**
 * Bookmarks moved out of Settings and into All conversations (v37 ruling 3:
 * "Bookmarks live with conversations, not Settings"). Keep this route as a
 * permanent redirect so existing bookmarks and shared links land on the
 * Bookmarked filter rather than a 404.
 */
export function BookmarksRedirectPage() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate(`${routes.conversations}?filter=bookmarked`, { replace: true });
  }, [navigate]);

  return null;
}
