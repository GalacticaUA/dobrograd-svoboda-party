import type { Application, AvailabilitySlot, CmsContent, Member, PartyEvent } from "@/types/party";

export const mockMembers: Member[] = [
  { id: "m1", username: "l.martinez", nickname: "Леонардо", discord: "leo_freedom", steamId: "76561198000000001", role: "leader", hours: 412, joinedAt: "2018-03-01" },
  { id: "m2", username: "p.mcguire", nickname: "Пётр", discord: "mcguire.data", steamId: "76561198000000002", role: "admin", hours: 356, joinedAt: "2018-03-01" },
  { id: "m3", username: "i.volkova", nickname: "Ирина", discord: "irina_v", steamId: "76561198000000003", role: "admin", hours: 241, joinedAt: "2019-06-12" },
  { id: "m4", username: "a.reyes", nickname: "Антон", discord: "reyes#2041", steamId: "76561198000000004", role: "member", hours: 132, joinedAt: "2020-09-20" },
  { id: "m5", username: "d.melnik", nickname: "Дарья", discord: "dasha.m", steamId: "76561198000000005", role: "member", hours: 118, joinedAt: "2021-02-14" },
  { id: "m6", username: "k.sokolov", nickname: "Кирилл", discord: "sokol_k", steamId: "76561198000000006", role: "member", hours: 74, joinedAt: "2023-05-03" },
  { id: "m7", username: "m.orlova", nickname: "Мария", discord: "orlova.m", steamId: "76561198000000007", role: "member", hours: 56, joinedAt: "2024-01-22" },
  { id: "m8", username: "v.petrov", nickname: "Влад", discord: "vlad_p", steamId: "76561198000000008", role: "member", hours: 31, joinedAt: "2025-08-10" },
];

export const mockApplications: Application[] = [
  { id: "a1", source: "native", name: "Елена Смирнова", email: "elena@mail.ru", phone: "+7 900 111-22-33", discord: "lena_s", steam: "76561198100000001", motivation: "Хочу помогать жителям своего двора разбираться с управляющей компанией. Юрист по образованию.", submittedAt: "2026-09-24", status: "pending", notes: "" },
  { id: "a2", source: "native", name: "Игорь Ким", email: "kim.igor@yandex.ru", phone: "+7 901 555-44-11", discord: "igor.kim", steam: "76561198100000002", motivation: "Владелец небольшой кофейни. Готов делиться опытом по налогам и проверкам.", submittedAt: "2026-09-23", status: "pending", notes: "" },
  { id: "a3", source: "google", name: "Sofia Brandt", email: "sofia.b@gmail.com", phone: "+7 902 333-00-99", discord: "sofiab", steam: "76561198100000003", motivation: "Data analyst, want to help with open budget visualisations for district assemblies.", submittedAt: "2026-09-22", status: "pending", notes: "" },
  { id: "a4", source: "google", name: "Артём Новиков", email: "artem.n@mail.ru", phone: "+7 903 777-12-12", discord: "artem_nov", steam: "76561198100000004", motivation: "Студент, могу вести соцсети и снимать уличные интервью.", submittedAt: "2026-09-20", status: "pending", notes: "" },
  { id: "a5", source: "native", name: "Ольга Белова", email: "belova@list.ru", phone: "+7 904 222-88-77", discord: "olga.b", steam: "—", motivation: "Пенсионерка, активистка ТСЖ. Хочу участвовать в дворовых собраниях.", submittedAt: "2026-09-18", status: "pending", notes: "" },
];

export const mockEvents: PartyEvent[] = [
  { id: "e1", title: "Дворовое собрание — Северный район", date: "2026-09-29", time: "19:00", location: "Двор ул. Лесная, 12", hours: 2, rsvps: ["m1", "m4", "m5"], attended: [] },
  { id: "e2", title: "Бесплатная юридическая консультация", date: "2026-10-01", time: "17:00", location: "Приёмная, пр. Мира, 5", hours: 3, rsvps: ["m3", "m6"], attended: [] },
  { id: "e3", title: "Открытый бюджет: разбор сметы", date: "2026-10-04", time: "12:00", location: "Библиотека №3", hours: 2, rsvps: ["m2", "m7", "m8"], attended: [] },
  { id: "e4", title: "Уличные интервью — Центр", date: "2026-10-06", time: "15:00", location: "Центральная площадь", hours: 4, rsvps: [], attended: [] },
];

export const mockAvailability: AvailabilitySlot[] = [
  { id: "s1", memberId: "m1", date: "2026-10-10", from: 17, to: 22 },
  { id: "s2", memberId: "m2", date: "2026-10-10", from: 18, to: 21 },
  { id: "s3", memberId: "m3", date: "2026-10-10", from: 12, to: 19 },
  { id: "s4", memberId: "m4", date: "2026-10-10", from: 19, to: 23 },
  { id: "s5", memberId: "m5", date: "2026-10-10", from: 18, to: 20 },
  { id: "s6", memberId: "m6", date: "2026-10-10", from: 10, to: 14 },
  { id: "s7", memberId: "m7", date: "2026-10-10", from: 19, to: 22 },
  { id: "s8", memberId: "m8", date: "2026-10-11", from: 12, to: 18 },
  { id: "s9", memberId: "m3", date: "2026-10-11", from: 14, to: 17 },
  { id: "s10", memberId: "m5", date: "2026-10-11", from: 13, to: 16 },
];

export const mockCms: CmsContent = {
  heroTitle: "Свобода",
  heroSubtitle: "Ваш голос - ваша сила. Ваше будущее - наш приоритет!",
  mission: "Основанная в 2018 году в Доброграде политическая сила, созданная жителями для жителей. Мы боремся за прозрачность муниципалитета, открытый бюджет и честное самоуправление без бюрократии.",
  transparencyTitle: "",
  transparencyText: "",
};

export const weeklyParticipation = [
  { week: "Нед 1", участники: 42, часы: 120 },
  { week: "Нед 2", участники: 51, часы: 148 },
  { week: "Нед 3", участники: 47, часы: 139 },
  { week: "Нед 4", участники: 63, часы: 187 },
  { week: "Нед 5", участники: 58, часы: 171 },
  { week: "Нед 6", участники: 72, часы: 214 },
  { week: "Нед 7", участники: 81, часы: 240 },
];

export const communityReach = [
  { district: "Сев.", охват: 1200 },
  { district: "Юж.", охват: 860 },
  { district: "Центр", охват: 2100 },
  { district: "Зап.", охват: 740 },
  { district: "Вост.", охват: 980 },
  { district: "Реч.", охват: 610 },
  { district: "Лесн.", охват: 530 },
  { district: "Пром.", охват: 450 },
  { district: "Нов.", охват: 890 },
];
