// Every variable is listed in the root .env.example. An empty value (as copied from it) counts as unset.
export const config = {
  port: Number(process.env.PORT || 8080),
  databasePath: process.env.DATABASE_PATH || "setllend.db",
};
