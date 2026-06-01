import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listEmployees,
  listAttendance,
  createEmployee,
  updateEmployee,
  deleteEmployee,
} from "@/lib/admin.functions";
import {
  listStores,
  createStore,
  updateStore,
  deleteStore,
  bulkCreateStores,
} from "@/lib/stores.functions";
import { getDashboardMetrics, getEmployeeSummary } from "@/lib/dashboard.functions";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Plus, Trash2, Pencil, Download, LogIn, LogOut, Users, History,
  LayoutDashboard, Store as StoreIcon, AlertTriangle, Sparkles,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/")({
  component: AdminDashboard,
});

type EmployeeRole = "cajero" | "gerente" | "seguridad";

function AdminDashboard() {
  return (
    <Tabs defaultValue="dashboard" className="space-y-4">
      <TabsList className="bg-card border border-border">
        <TabsTrigger value="dashboard" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">
          <LayoutDashboard className="h-4 w-4 mr-2" />
          Dashboard
        </TabsTrigger>
        <TabsTrigger value="attendance" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">
          <History className="h-4 w-4 mr-2" />
          Marcajes
        </TabsTrigger>
        <TabsTrigger value="employees" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">
          <Users className="h-4 w-4 mr-2" />
          Colaboradores
        </TabsTrigger>
        <TabsTrigger value="stores" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">
          <StoreIcon className="h-4 w-4 mr-2" />
          Tiendas
        </TabsTrigger>
      </TabsList>
      <TabsContent value="dashboard">
        <DashboardPanel />
      </TabsContent>
      <TabsContent value="attendance">
        <AttendancePanel />
      </TabsContent>
      <TabsContent value="employees">
        <EmployeesPanel />
      </TabsContent>
      <TabsContent value="stores">
        <StoresPanel />
      </TabsContent>
    </Tabs>
  );
}

function AttendancePanel() {
  const fetchFn = useServerFn(listAttendance);
  const { data, isLoading } = useQuery({
    queryKey: ["attendance"],
    queryFn: () => fetchFn({ data: { limit: 200 } }),
    refetchInterval: 15_000,
  });

  const rows = data ?? [];

  const exportCsv = () => {
    const header = ["Fecha", "Hora", "Colaborador", "Código", "Rol", "Tienda", "Tipo"];
    const lines = rows.map((r) => {
      const d = new Date(r.created_at);
      const emp = Array.isArray(r.employee) ? r.employee[0] : r.employee;
      const st = Array.isArray(r.store) ? r.store[0] : r.store;
      return [
        d.toLocaleDateString("es-MX"),
        d.toLocaleTimeString("es-MX"),
        emp?.full_name ?? "",
        emp?.employee_code ?? "",
        emp?.role ?? "",
        st ? `${st.code} · ${st.name}` : "",
        r.type,
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",");
    });
    const csv = [header.join(","), ...lines].join("\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `marcajes-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-foreground">Historial de marcajes</h2>
          <p className="text-sm text-muted-foreground">Últimos {rows.length} registros (se actualiza cada 15s)</p>
        </div>
        <Button onClick={exportCsv} variant="outline" disabled={rows.length === 0}>
          <Download className="h-4 w-4 mr-2" /> Exportar CSV
        </Button>
      </div>

      <div className="bg-card rounded-2xl border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-secondary/50">
              <TableHead>Selfie</TableHead>
              <TableHead>Fecha / Hora</TableHead>
              <TableHead>Colaborador</TableHead>
              <TableHead>Rol</TableHead>
              <TableHead>Tienda</TableHead>
              <TableHead>Tipo</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  Cargando…
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  Aún no hay marcajes registrados.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => {
                const d = new Date(r.created_at);
                const emp = Array.isArray(r.employee) ? r.employee[0] : r.employee;
                const st = Array.isArray(r.store) ? r.store[0] : r.store;
                return (
                  <TableRow key={r.id}>
                    <TableCell>
                      {r.selfie_url ? (
                        <a href={r.selfie_url} target="_blank" rel="noopener noreferrer">
                          <img
                            src={r.selfie_url}
                            alt="selfie"
                            className="h-12 w-12 rounded-lg object-cover border border-border"
                          />
                        </a>
                      ) : (
                        <div className="h-12 w-12 rounded-lg bg-muted" />
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="font-medium text-foreground">{d.toLocaleDateString("es-MX")}</div>
                      <div className="text-xs text-muted-foreground font-mono">
                        {d.toLocaleTimeString("es-MX")}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium text-foreground">{emp?.full_name}</div>
                      <div className="text-xs text-muted-foreground">{emp?.employee_code}</div>
                    </TableCell>
                    <TableCell className="capitalize text-muted-foreground">{emp?.role}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {st ? `${st.code} · ${st.name}` : "—"}
                    </TableCell>
                    <TableCell>
                      {r.type === "entrada" ? (
                        <Badge className="bg-primary text-primary-foreground hover:bg-primary">
                          <LogIn className="h-3 w-3 mr-1" /> Entrada
                        </Badge>
                      ) : (
                        <Badge className="bg-accent text-accent-foreground hover:bg-accent">
                          <LogOut className="h-3 w-3 mr-1" /> Salida
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function EmployeesPanel() {
  const fetchFn = useServerFn(listEmployees);
  const createFn = useServerFn(createEmployee);
  const updateFn = useServerFn(updateEmployee);
  const deleteFn = useServerFn(deleteEmployee);
  const storesFn = useServerFn(listStores);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["employees"],
    queryFn: () => fetchFn(),
  });
  const { data: stores } = useQuery({ queryKey: ["stores"], queryFn: () => storesFn() });

  const employees = data ?? [];
  const storeList = stores ?? [];

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<(typeof employees)[number] | null>(null);
  const [form, setForm] = useState({
    employee_code: "",
    full_name: "",
    role: "cajero" as EmployeeRole,
    store_id: "",
    pin: "",
    active: true,
  });

  useEffect(() => {
    if (editing) {
      setForm({
        employee_code: editing.employee_code,
        full_name: editing.full_name,
        role: editing.role as EmployeeRole,
        store_id: editing.store_id ?? "",
        pin: "",
        active: editing.active,
      });
    } else {
      setForm({
        employee_code: "",
        full_name: "",
        role: "cajero",
        store_id: storeList[0]?.id ?? "",
        pin: "",
        active: true,
      });
    }
  }, [editing, open, storeList]);

  const save = async () => {
    if (!form.store_id) {
      toast.error("Selecciona una tienda");
      return;
    }
    try {
      if (editing) {
        await updateFn({
          data: {
            id: editing.id,
            full_name: form.full_name,
            role: form.role,
            store_id: form.store_id,
            active: form.active,
            ...(form.pin ? { pin: form.pin } : {}),
          },
        });
        toast.success("Colaborador actualizado");
      } else {
        await createFn({
          data: {
            employee_code: form.employee_code,
            full_name: form.full_name,
            role: form.role,
            store_id: form.store_id,
            pin: form.pin,
            active: form.active,
          },
        });
        toast.success("Colaborador creado");
      }
      setOpen(false);
      setEditing(null);
      qc.invalidateQueries({ queryKey: ["employees"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error al guardar");
    }
  };

  const remove = async (id: string) => {
    if (!confirm("¿Eliminar este colaborador? Se borrarán también sus marcajes.")) return;
    try {
      await deleteFn({ data: { id } });
      toast.success("Colaborador eliminado");
      qc.invalidateQueries({ queryKey: ["employees"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error al eliminar");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-foreground">Colaboradores</h2>
          <p className="text-sm text-muted-foreground">{employees.length} registrados</p>
        </div>
        <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setEditing(null); }}>
          <DialogTrigger asChild>
            <Button className="bg-accent text-accent-foreground hover:bg-accent/90">
              <Plus className="h-4 w-4 mr-2" /> Nuevo colaborador
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editing ? "Editar colaborador" : "Nuevo colaborador"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>Código de empleado</Label>
                <Input
                  disabled={!!editing}
                  value={form.employee_code}
                  onChange={(e) => setForm({ ...form, employee_code: e.target.value })}
                  placeholder="Ej. 1001"
                />
              </div>
              <div>
                <Label>Nombre completo</Label>
                <Input
                  value={form.full_name}
                  onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Rol</Label>
                  <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v as EmployeeRole })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cajero">Cajero</SelectItem>
                      <SelectItem value="gerente">Gerente</SelectItem>
                      <SelectItem value="seguridad">Seguridad</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Tienda</Label>
                  <Select value={form.store_id} onValueChange={(v) => setForm({ ...form, store_id: v })}>
                    <SelectTrigger><SelectValue placeholder="Selecciona…" /></SelectTrigger>
                    <SelectContent>
                      {storeList.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.code} · {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label>{editing ? "PIN nuevo (dejar vacío para mantener)" : "PIN (4-8 dígitos)"}</Label>
                <Input
                  type="text"
                  inputMode="numeric"
                  pattern="\d*"
                  maxLength={8}
                  value={form.pin}
                  onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, "") })}
                  placeholder={editing ? "••••" : "Ej. 1234"}
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(e) => setForm({ ...form, active: e.target.checked })}
                />
                Activo
              </label>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
              <Button onClick={save} className="bg-accent text-accent-foreground hover:bg-accent/90">
                Guardar
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="bg-card rounded-2xl border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-secondary/50">
              <TableHead>Código</TableHead>
              <TableHead>Nombre</TableHead>
              <TableHead>Rol</TableHead>
              <TableHead>Tienda</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead className="text-right">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Cargando…</TableCell></TableRow>
            ) : employees.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                Aún no hay colaboradores. Crea el primero para empezar a marcar.
              </TableCell></TableRow>
            ) : employees.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="font-mono text-foreground">{e.employee_code}</TableCell>
                <TableCell className="font-medium text-foreground">{e.full_name}</TableCell>
                <TableCell className="capitalize text-muted-foreground">{e.role}</TableCell>
                <TableCell className="text-muted-foreground">
                  {(() => {
                    const s = storeList.find((x) => x.id === e.store_id);
                    return s ? `${s.code} · ${s.name}` : (e.store ?? "—");
                  })()}
                </TableCell>
                <TableCell>
                  {e.active ? (
                    <Badge className="bg-[oklch(0.65_0.16_155)] text-white hover:bg-[oklch(0.65_0.16_155)]">Activo</Badge>
                  ) : (
                    <Badge variant="secondary">Inactivo</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => { setEditing(e); setOpen(true); }}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => remove(e.id)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}