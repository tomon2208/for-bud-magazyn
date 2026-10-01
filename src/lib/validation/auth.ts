import { z } from "zod";

/** Domena technicznych adresów e-mail w Supabase Auth (login → e-mail). */
export const LOGIN_EMAIL_DOMAIN = "forbud.local";

export const ROLES = ["ADMIN", "BIURO", "PRODUKCJA"] as const;
export type AppRole = (typeof ROLES)[number];

export const ROLE_LABELS: Record<AppRole, string> = {
  ADMIN: "Administrator",
  BIURO: "Biuro",
  PRODUKCJA: "Produkcja",
};

export const LOGIN_REGEX = /^[a-z0-9._-]{3,32}$/;
export const PASSWORD_MIN_LENGTH = 8;
/** bcrypt w Supabase Auth bierze pod uwagę maks. 72 bajty. */
export const PASSWORD_MAX_LENGTH = 72;

/** Login: przycinany i zamieniany na małe litery przed walidacją. */
export const loginSchema = z
  .string({ error: "Podaj login" })
  .trim()
  .toLowerCase()
  .regex(LOGIN_REGEX, {
    error: "Login: 3–32 znaki, tylko małe litery a–z, cyfry, kropka, myślnik i podkreślenie",
  });

export const passwordSchema = z
  .string({ error: "Podaj hasło" })
  .min(PASSWORD_MIN_LENGTH, { error: `Hasło musi mieć co najmniej ${PASSWORD_MIN_LENGTH} znaków` })
  .refine((v) => new TextEncoder().encode(v).length <= PASSWORD_MAX_LENGTH, {
    error: `Hasło może mieć maksymalnie ${PASSWORD_MAX_LENGTH} bajtów`,
  });

export const roleSchema = z.enum(ROLES, { error: "Nieprawidłowa rola" });

export const fullNameSchema = z
  .string({ error: "Podaj imię i nazwisko" })
  .trim()
  .min(1, { error: "Podaj imię i nazwisko" })
  .max(120, { error: "Imię i nazwisko może mieć maksymalnie 120 znaków" });

/** Formularz logowania — bez reguł siły hasła (nie zdradzamy niczego przy logowaniu). */
export const loginFormSchema = z.object({
  login: z.string().trim().toLowerCase().min(1).max(64),
  password: z.string().min(1).max(200),
});

export const createUserSchema = z.object({
  login: loginSchema,
  full_name: fullNameSchema,
  role: roleSchema,
  password: passwordSchema,
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z
  .object({
    full_name: fullNameSchema.optional(),
    role: roleSchema.optional(),
    active: z.boolean({ error: "Pole active musi być typu logicznego" }).optional(),
    password: passwordSchema.optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    error: "Brak zmian do zapisania",
  });
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const userIdSchema = z.uuid({ error: "Nieprawidłowy identyfikator użytkownika" });

/** Login → techniczny e-mail w Supabase Auth. Zakłada login już znormalizowany. */
export function loginToEmail(login: string): string {
  return `${login.trim().toLowerCase()}@${LOGIN_EMAIL_DOMAIN}`;
}
