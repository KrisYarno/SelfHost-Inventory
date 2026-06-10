import { requireCSRF } from "@/lib/api-utils";
import { AppError } from "@/lib/error-handling";

jest.mock("@/lib/csrf", () => ({ validateCSRFToken: jest.fn() }));
import { validateCSRFToken } from "@/lib/csrf";

test("passes when token valid", async () => {
  (validateCSRFToken as jest.Mock).mockResolvedValue(true);
  await expect(requireCSRF({} as never)).resolves.toBeUndefined();
});

test("throws AppError CSRF_INVALID 403 when invalid", async () => {
  (validateCSRFToken as jest.Mock).mockResolvedValue(false);
  const err = await requireCSRF({} as never).catch((e) => e);
  expect(err).toBeInstanceOf(AppError);
  expect(err.code).toBe("CSRF_INVALID");
  expect(err.statusCode).toBe(403);
});
