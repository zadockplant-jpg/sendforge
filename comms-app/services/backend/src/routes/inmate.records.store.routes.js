import { Router } from "express";
import {
  getActiveInmateRecordsProductBySlug,
  listActiveInmateRecordsProducts,
} from "../services/inmate.records/products.service.js";
import { createInmateRecordsCheckoutSession } from "../services/inmate.records/checkout.service.js";
import { getInmateRecordsOrderPublic } from "../services/inmate.records/orders.service.js";

export const inmateRecordsStoreRouter = Router();

inmateRecordsStoreRouter.get("/products", async (_req, res) => {
  try {
    const products = await listActiveInmateRecordsProducts();

    return res.json({
      ok: true,
      products,
    });
  } catch (err) {
    return res.status(500).json({
      error: "server_error",
      message: String(err?.message || err),
    });
  }
});

inmateRecordsStoreRouter.get("/products/:slug", async (req, res) => {
  try {
    const product = await getActiveInmateRecordsProductBySlug(req.params.slug);

    if (!product) {
      return res.status(404).json({ error: "product_not_found" });
    }

    return res.json({
      ok: true,
      product,
    });
  } catch (err) {
    return res.status(500).json({
      error: "server_error",
      message: String(err?.message || err),
    });
  }
});

inmateRecordsStoreRouter.post("/checkout", async (req, res) => {
  try {
    const checkout = await createInmateRecordsCheckoutSession(req.body);

    return res.json({
      ok: true,
      ...checkout,
    });
  } catch (err) {
    const statusCode = err?.statusCode || 500;

    return res.status(statusCode).json({
      error:
        statusCode === 400
          ? "invalid_checkout_payload"
          : statusCode === 404
            ? "variant_not_found"
            : "server_error",
      message: String(err?.message || err),
      details: err?.details || undefined,
    });
  }
});

inmateRecordsStoreRouter.get("/orders/:orderId", async (req, res) => {
  try {
    const order = await getInmateRecordsOrderPublic(req.params.orderId);

    if (!order) {
      return res.status(404).json({ error: "order_not_found" });
    }

    return res.json({
      ok: true,
      order,
    });
  } catch (err) {
    return res.status(500).json({
      error: "server_error",
      message: String(err?.message || err),
    });
  }
});
