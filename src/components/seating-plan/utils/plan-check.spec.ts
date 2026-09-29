import { checkPlan } from "./plan-check.util";

const sector = (over: any = {}) => ({
  id: 1,
  kind: "sector",
  title: "VIP",
  sectorType: "seating",
  numbering: {},
  ticket: {
    price: 3000,
    categories: ["business_class"],
    availability: "available",
  },
  ...over,
});
const row = (
  id: number,
  index: number,
  seatsCount: number,
  label = `Row ${index + 1}`,
) => ({
  id,
  sectorId: 1,
  index,
  label,
  seatsCount,
  ticket: null,
});
const object = (over: any) => ({
  kind: "object",
  parentId: null,
  isSellable: true,
  ticket: {},
  ...over,
});

describe("проверка схемы перед публикацией", () => {
  it("пропускает схему, где у всех мест в продаже есть цена", () => {
    const { problem } = checkPlan([sector()], [row(10, 0, 4)], []);
    expect(problem).toBeNull();
  });

  it("не публикует места с ценой 0 и говорит, где цены не хватает", () => {
    const nodes = [
      sector({ ticket: { price: "", categories: ["economy_class"] } }),
      object({ id: 20, objectType: "add_chair" }),
      object({ id: 21, objectType: "add_sofa", capacity: 3 }),
      object({ id: 22, objectType: "add_chair", ticket: { price: 500 } }),
    ];
    const { problem } = checkPlan(nodes, [row(10, 0, 4)], []);
    expect(problem?.message).toBe("zero_price_seats");
    expect(problem?.statusCode).toBe(400);
    const summary = problem?.places?.map(
      (place) => `${place.sectorId}:${place.source}:${place.seatsCount}`,
    );
    expect(summary).toEqual([
      "1:rows:4",
      "null:add_chair:1",
      "null:add_sofa:3",
    ]);
  });

  it("снятые с продажи места без цены публикации не мешают", () => {
    const nodes = [
      sector(),
      object({
        id: 20,
        objectType: "add_chair",
        ticket: { availability: "unavailable" },
      }),
    ];
    const seats = [
      {
        rowId: 10,
        sectorId: 1,
        index: 0,
        ticket: { price: 0, availability: "unavailable" },
      },
    ];
    expect(checkPlan(nodes, [row(10, 0, 4)], seats).problem).toBeNull();
  });

  it("одинаковые подписи рядов в секторе — конфликт", () => {
    const { problem } = checkPlan(
      [sector()],
      [row(10, 0, 4, "A"), row(11, 1, 4, "A")],
      [],
    );
    expect(problem).toMatchObject({
      statusCode: 409,
      message: "duplicate_row_label:1:A",
    });
  });
});
