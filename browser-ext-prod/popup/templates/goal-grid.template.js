"use strict";

function buildPopupGoalCard(goal, onSelect) {
  const button = createPopupElement("button", "goal-card");
  button.type = "button";
  button.dataset.goalId = goal.id;
  button.appendChild(createPopupElement("strong", "", goal.label));
  button.appendChild(createPopupElement("span", "", goal.description));
  button.addEventListener("click", () => onSelect(goal.id));
  return button;
}
