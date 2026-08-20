export function removeAppServerNullableFields(value) {
  if (Array.isArray(value)) return value.map(removeAppServerNullableFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== null)
    .map(([key, entry]) => [key, removeAppServerNullableFields(entry)]));
}
