"use strict";

function buildCampusCalendarDraftUrl(context) {
  const activity = toText(context?.activityTitle) || "Actividad Campus Virtual";
  const deadline = toText(context?.activityDeadline);
  const details = [
    "Actividad detectada por ADACEEN.",
    deadline ? `Fecha visible: ${deadline}` : "",
    toText(context?.url) ? `Pagina: ${context.url}` : "",
  ].filter(Boolean).join("\n");

  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `ADACEEN: ${activity}`,
    details,
  });

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
