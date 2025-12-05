import type { JsonApiRelationship } from "../models/jsonApi";

export const extractRelationshipIds = (relationship?: JsonApiRelationship): string[] => {
  if (!relationship || relationship.data == null) return [];

  if (Array.isArray(relationship.data)) {
    return relationship.data
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }

  const singleData = relationship.data as { id?: string } | null;
  return singleData?.id ? [singleData.id] : [];
};

export const extractFirstRelationshipId = (relationship?: JsonApiRelationship): string | null => {
  const ids = extractRelationshipIds(relationship);
  return ids.length > 0 ? ids[0]! : null;
};
