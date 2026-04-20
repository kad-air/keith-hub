import type { Metadata } from "next";
import {
  anyDayDoneToday,
  dayIdFor,
  getCurriculum,
  resolveToday,
} from "@/lib/practice/config";
import { LICKS, type Lick } from "@/lib/practice/licks";
import {
  getDoneDayIds,
  getLearnedLickIds,
  getStreak,
  isDone,
} from "@/lib/practice/progress";
import { TodayClient } from "./TodayClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Today — Practice — hub" };

export default function TodayPage() {
  const curriculum = getCurriculum();
  const doneDayIds = getDoneDayIds();
  const card = resolveToday(curriculum, doneDayIds);
  const doneToday = anyDayDoneToday();
  const streak = getStreak();
  const learnedLicks = getLearnedLickIds();

  // Only inline the referenced licks so the client bundle stays small.
  const licksForDay: Lick[] =
    card.kind === "next"
      ? card.day.lickIds
          .map((id) => LICKS.find((l) => l.id === id))
          .filter((l): l is Lick => Boolean(l))
      : [];

  const dayIsDone =
    card.kind === "next" ? isDone(dayIdFor(card.day.day)) : false;

  // Key on the current day number so switching days (after Mark Done advances
  // the curriculum pointer) remounts the client and clears any optimistic
  // state from the previous day.
  const key = card.kind === "next" ? `day-${card.day.day}` : "complete";

  return (
    <TodayClient
      key={key}
      card={card}
      preCheck={curriculum.preCheck}
      licksForDay={licksForDay}
      learnedLickIds={Array.from(learnedLicks)}
      streak={streak}
      doneToday={doneToday}
      dayIsDone={dayIsDone}
    />
  );
}
