// Campus: tipos de la entrada y del analisis de una pagina del curso, y sus topes.

export type CampusSource = "browser_dom" | "moodle_api";

export type CampusActivityType =
  | "assign"
  | "quiz"
  | "resource"
  | "url"
  | "page"
  | "forum"
  | "book"
  | "folder"
  | "unknown";

export type CampusLinkInput = {
  text?: unknown;
  href?: unknown;
  kind?: unknown;
};

export type CampusActivityInput = {
  title?: unknown;
  type?: unknown;
  url?: unknown;
  description?: unknown;
  sectionTitle?: unknown;
  sectionHtml?: unknown;
  visibleDueText?: unknown;
  dueAt?: unknown;
};

export type CampusAnalyzeInput = {
  courseId?: number | null;
  source?: unknown;
  url?: unknown;
  title?: unknown;
  visibleText?: unknown;
  text?: unknown;
  selection?: unknown;
  links?: CampusLinkInput[];
  activities?: CampusActivityInput[];
};

export type CampusActivity = {
  id: string;
  courseId: number | null;
  title: string;
  type: CampusActivityType;
  url: string;
  description: string;
  sectionTitle: string;
  visibleDueText: string;
  dueAt: string | null;
  source: CampusSource;
};

export type CampusMaterial = {
  title: string;
  type: CampusActivityType;
  url: string;
  sectionTitle: string;
};

export type CampusAgendaItem = {
  title: string;
  type: CampusActivityType;
  url: string;
  dueAt: string | null;
  visibleDueText: string;
};

export type CampusAnalysis = {
  course: {
    id: number | null;
    title: string;
    url: string;
  };
  source: CampusSource;
  summary: string;
  activities: CampusActivity[];
  tasks: CampusActivity[];
  materials: CampusMaterial[];
  agenda: CampusAgendaItem[];
  recommendations: string[];
  links: CampusMaterial[];
  stats: {
    activityCount: number;
    taskCount: number;
    materialCount: number;
    linkCount: number;
    deadlineCount: number;
  };
};

export const MAX_TEXT_CHARS = 120000;

export const MAX_ITEMS = 160;
