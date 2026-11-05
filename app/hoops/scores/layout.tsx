import { ViewerTzProvider } from "@/components/hoops/scores/ViewerTz";
import { viewerTz } from "@/lib/hoops/scores/viewerTz";

/** Every scores page runs in the viewer's time zone (ViewerTz.tsx). */
export default function ScoresLayout({ children }: { children: React.ReactNode }) {
  return <ViewerTzProvider tz={viewerTz()}>{children}</ViewerTzProvider>;
}
