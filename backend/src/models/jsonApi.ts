export interface JsonApiResource<TAttributes = Record<string, unknown>> {
  id: string;
  type: string;
  attributes: TAttributes;
  relationships?: Record<string, JsonApiRelationship>;
}

export interface JsonApiRelationship {
  data:
    | { id: string; type: string }
    | { id: string; type: string }[]
    | null;
}

export interface JsonApiResponse<TResource> {
  data: TResource | TResource[];
  included?: JsonApiResource[];
}

