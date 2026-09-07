import "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      screeningMode?: "user" | "pro" | "guardian" | "general";
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    screeningMode?: "user" | "pro" | "guardian" | "general";
  }
}
