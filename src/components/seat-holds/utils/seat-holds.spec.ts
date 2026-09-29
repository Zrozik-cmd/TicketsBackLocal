import {
  attachSeatsToLines,
  checkOrderSeats,
  lineSeatsOf,
  seatLabelText,
  ticketPlacementFields,
} from "./seat-holds.util";

const seat = (id: number, zone: string, over: any = {}) => ({
  id,
  label: `Row 1 - Seat#${id}`,
  eventZoneId: zone,
  saleStatus: "FREE",
  ...over,
});
const seats = new Map(
  [
    seat(1, "z-a"),
    seat(2, "z-a"),
    seat(3, "z-b"),
    seat(4, "z-a", { saleStatus: "BLOCKED" }),
  ].map((s) => [s.id, s]),
);

describe("закрепление мест схемы за заказом", () => {
  it("принимает места своей зоны ровно по числу билетов", () => {
    const { error, lines } = checkOrderSeats(
      [
        { zoneId: "z-a", count: 2, seatIds: [1, 2] },
        { zoneId: "z-c", count: 3 },
      ],
      seats,
    );
    expect(error).toBeNull();
    expect(lines).toEqual([
      {
        zoneId: "z-a",
        seats: [
          { id: 1, label: "Row 1 - Seat#1" },
          { id: 2, label: "Row 1 - Seat#2" },
        ],
      },
    ]);
  });

  it("отказывает: чужая зона, снятое с продажи, дубль, не то число, сеанс", () => {
    expect(
      checkOrderSeats([{ zoneId: "z-a", count: 1, seatIds: [3] }], seats).error,
    ).toBe("seat_not_in_zone");
    expect(
      checkOrderSeats([{ zoneId: "z-a", count: 1, seatIds: [4] }], seats).error,
    ).toBe("seat_not_in_zone");
    expect(
      checkOrderSeats([{ zoneId: "z-a", count: 1, seatIds: [99] }], seats)
        .error,
    ).toBe("seat_not_in_zone");
    expect(
      checkOrderSeats([{ zoneId: "z-a", count: 2, seatIds: [1, 1] }], seats)
        .error,
    ).toBe("seat_duplicated");
    expect(
      checkOrderSeats([{ zoneId: "z-a", count: 3, seatIds: [1, 2] }], seats)
        .error,
    ).toBe("seats_count_mismatch");
    expect(
      checkOrderSeats(
        [{ zoneId: "z-a", count: 1, seatIds: [1], session: 5 }],
        seats,
      ).error,
    ).toBe("seats_not_for_sessions");
  });

  it("места уходят в строки заказа и оттуда — в билеты по порядку", () => {
    const lines = attachSeatsToLines(
      [
        { zoneId: "z-a", count: 2 },
        { zoneId: "z-c", count: 1 },
      ],
      [
        {
          zoneId: "z-a",
          seats: [
            { id: 1, label: "Row 1 - Seat#1" },
            { id: 2, label: "Row 1 - Seat#2" },
          ],
        },
      ],
    );
    expect(lines[1]).toEqual({ zoneId: "z-c", count: 1 });
    expect(ticketPlacementFields(lines[0] as any, 1)).toEqual({
      seatId: 2,
      seatLabel: "Row 1 - Seat#2",
    });
    expect(
      ticketPlacementFields({ session: 7, sessionDate: "2026-10-01" }, 0),
    ).toMatchObject({ session: 7, sessionDate: "2026-10-01" });
    expect(lineSeatsOf(lines as any)).toEqual([
      { zoneId: "z-a", seats: (lines[0] as any).seats },
    ]);
  });

  it("подпись места — на языке билета", () => {
    expect(seatLabelText("Row 3 - Seat#12", "ru")).toBe("Ряд 3, место 12");
    expect(seatLabelText("Row 3 - Seat#12", "en")).toBe("Row 3, seat 12");
    expect(seatLabelText("Sofa #21 - Seat#2", "ru")).toBe("Sofa #21, место 2");
    expect(seatLabelText("Table 7", "th")).toBe("Table 7");
  });
});
