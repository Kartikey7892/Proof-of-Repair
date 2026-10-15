export const normVin = (vin: string | null | undefined) => (vin ?? "").trim().toUpperCase();

export interface ParsedVehicle {
  year: number | null;
  make: string | null;
  model: string | null;
}

/** "2016 Honda Civic" → { year: 2016, make: "HONDA", model: "CIVIC" } (NHTSA casing). */
export function parseVehicle(vehicle: string | null | undefined): ParsedVehicle {
  const parts = (vehicle ?? "").trim().split(/\s+/).filter(Boolean);
  let year: number | null = null;
  if (parts[0] && /^(19|20)\d{2}$/.test(parts[0])) year = Number(parts.shift());
  const make = parts.shift()?.toUpperCase() ?? null;
  const model = parts.length ? parts.join(" ").toUpperCase() : null;
  return { year, make, model };
}
