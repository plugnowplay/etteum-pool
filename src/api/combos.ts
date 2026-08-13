import { Hono } from "hono";
import { broadcast } from "../ws/index";
import { deleteCombo, listCombos, saveCombo } from "../proxy/combos";

export const combosRouter = new Hono();

combosRouter.get("/", async (c) => c.json({ combos: await listCombos() }));

combosRouter.put("/", async (c) => {
  try {
    const combo = await saveCombo(await c.req.json());
    broadcast({ type: "combos_updated", data: { name: combo.name } });
    return c.json({ success: true, combo });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

combosRouter.delete("/:name", async (c) => {
  await deleteCombo(c.req.param("name"));
  broadcast({ type: "combos_updated", data: { name: c.req.param("name") } });
  return c.json({ success: true });
});
EOF
