export type Role = "leader" | "admin" | "member";

export type ApplicationStatus = "pending" | "approved" | "rejected";
export type ApplicationSource = "native" | "google";

export interface Member {
  id: string;
  username: string;
  nickname: string;
  discord: string;
  steamId: string;
  role: Role;
  hours: number;
  joinedAt: string;
}

export interface Application {
  id: string;
  source: ApplicationSource;
  name: string;
  email: string;
  phone: string;
  discord: string;
  steam: string;
  district: string;
  motivation: string;
  submittedAt: string;
  status: ApplicationStatus;
  notes: string;
}

export interface PartyEvent {
  id: string;
  title: string;
  date: string;
  time: string;
  location: string;
  hours: number;
  rsvps: string[];
  attended: string[];
}

export interface AvailabilitySlot {
  id: string;
  memberId: string;
  date: string;
  from: number;
  to: number;
}

export interface CmsContent {
  heroTitle: string;
  heroSubtitle: string;
  mission: string;
  transparencyTitle: string;
  transparencyText: string;
}

export interface NotificationPrefs {
  events: boolean;
  applications: boolean;
  news: boolean;
}
