/** Документ без служебных полей Mongo — для копий узлов, рядов и мест под новыми id. */
export function stripMeta(doc: any) {
  const { _id, id, __v, createdAt, updatedAt, ...rest } = doc;
  return rest;
}

/** Поля подписи (`text_label`), как пришли: незаданные не пишутся. */
export function labelFields(dto: any) {
  const fields: { text?: string; fontSize?: number; labelStyle?: string } = {};
  if (dto.text !== undefined) fields.text = String(dto.text);
  if (dto.fontSize !== undefined) fields.fontSize = Number(dto.fontSize);
  if (dto.labelStyle !== undefined) fields.labelStyle = dto.labelStyle;
  return fields;
}
