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
  listEmployeeAssignments,
  setEmployeeAssignments,
} from "@/lib/admin.functions";
import {
  listStores,
  createStore,
  updateStore,
  deleteStore,
  bulkCreateStores,
} from "@/lib/stores.functions";
import {
  beginWebauthnRegistration,
  finishWebauthnRegistration,
  listEmployeeCredentials,
  deleteEmployeeCredential,
} from "@/lib/webauthn.functions";
import { startRegistration } from "@simplewebauthn/browser";
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
  LayoutDashboard, Store as StoreIcon, AlertTriangle, Sparkles, Fingerprint, MapPin,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/")({
  component: AdminDashboard,
});

type EmployeeRole = "cajero" | "gerente" | "seguridad" | "agente_mbk" | "gerente_zona";

const ROLE_LABELS: Record<EmployeeRole, string> = {
  cajero: "Cajero",
  agente_mbk: "Agente MBK",
  gerente: "Gerente",
  gerente_zona: "Gerente de Zona",
  seguridad: "Seguridad",
};

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
    username: "",
    password: "",
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
        username: (editing as { username?: string | null }).username ?? "",
        password: "",
        active: editing.active,
      });
    } else {
      setForm({
        employee_code: "",
        full_name: "",
        role: "cajero",
        store_id: storeList[0]?.id ?? "",
        pin: "",
        username: "",
        password: "",
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
            ...(form.username !== ((editing as { username?: string | null }).username ?? "") ? { username: form.username || null } : {}),
            ...(form.password ? { password: form.password } : {}),
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
            username: form.username || undefined,
            password: form.password || undefined,
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
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Usuario (opcional)</Label>
                  <Input
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                    placeholder="ej. jperez"
                  />
                </div>
                <div>
                  <Label>{editing ? "Nueva contraseña" : "Contraseña"}</Label>
                  <Input
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    placeholder="6+ caracteres"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">Define PIN, o usuario+contraseña, o ambos. La huella se registra después con el botón <span className="inline-flex items-center gap-1"><Fingerprint className="h-3 w-3" /></span> en la lista.</p>
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
                  <FingerprintButton employeeId={e.id} employeeName={e.full_name} />
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

// =====================================================================
// DASHBOARD
// =====================================================================
function DashboardPanel() {
  const metricsFn = useServerFn(getDashboardMetrics);
  const summaryFn = useServerFn(getEmployeeSummary);
  const [days, setDays] = useState(7);

  const { data: m, isLoading } = useQuery({
    queryKey: ["dashboard", days],
    queryFn: () => metricsFn({ data: { days } }),
    refetchInterval: 20_000,
  });
  const { data: summary } = useQuery({
    queryKey: ["empSummary", days],
    queryFn: () => summaryFn({ data: { days } }),
  });

  if (isLoading || !m) {
    return <div className="text-center py-12 text-muted-foreground">Cargando dashboard…</div>;
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-foreground">Dashboard</h2>
          <p className="text-sm text-muted-foreground">
            Últimos {days} días · se actualiza cada 20 s
          </p>
        </div>
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="1">Hoy</SelectItem>
            <SelectItem value="7">7 días</SelectItem>
            <SelectItem value="30">30 días</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KPI label="Entradas hoy" value={m.today_entries} accent="entry" />
        <KPI label="Salidas hoy" value={m.today_exits} accent="exit" />
        <KPI label="Dentro ahora" value={m.inside_now} accent="primary" />
        <KPI label={`Marcajes (${days}d)`} value={m.total_period} accent="muted" />
      </div>

      {m.stuck_open.length > 0 && (
        <div className="bg-card border border-[oklch(0.7_0.18_50)] rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-2 text-[oklch(0.65_0.18_50)] font-semibold">
            <AlertTriangle className="h-4 w-4" />
            Alertas — sesiones abiertas hace más de 10 h
          </div>
          <ul className="text-sm space-y-1">
            {m.stuck_open.map((s) => (
              <li key={s.id} className="text-foreground">
                <span className="font-mono">{s.employee_code}</span> · {s.full_name}
                <span className="text-muted-foreground"> — desde {new Date(s.since).toLocaleString("es-MX")}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="bg-card rounded-2xl border border-border overflow-hidden">
          <div className="p-4 border-b border-border">
            <h3 className="font-semibold text-foreground">Dentro ahora</h3>
            <p className="text-xs text-muted-foreground">Entrada sin salida registrada hoy</p>
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-secondary/50">
                <TableHead>Colaborador</TableHead>
                <TableHead>Desde</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {m.inside.length === 0 ? (
                <TableRow><TableCell colSpan={2} className="text-center py-6 text-muted-foreground">Nadie adentro.</TableCell></TableRow>
              ) : m.inside.map((i) => (
                <TableRow key={i.id}>
                  <TableCell>
                    <div className="font-medium text-foreground">{i.full_name}</div>
                    <div className="text-xs text-muted-foreground font-mono">{i.employee_code}</div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(i.since).toLocaleTimeString("es-MX")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {m.is_admin && (
          <div className="bg-card rounded-2xl border border-border overflow-hidden">
            <div className="p-4 border-b border-border">
              <h3 className="font-semibold text-foreground">Ranking de tiendas</h3>
              <p className="text-xs text-muted-foreground">Por actividad en el periodo</p>
            </div>
            <Table>
              <TableHeader>
                <TableRow className="bg-secondary/50">
                  <TableHead>Tienda</TableHead>
                  <TableHead className="text-right">Hoy</TableHead>
                  <TableHead className="text-right">Dentro</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {m.by_store.slice(0, 15).map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <span className="font-mono text-foreground">{s.code}</span>{" "}
                      <span className="text-muted-foreground">· {s.name}</span>
                    </TableCell>
                    <TableCell className="text-right text-sm">{s.today_entries}/{s.today_exits}</TableCell>
                    <TableCell className="text-right text-sm">{s.inside_now}</TableCell>
                    <TableCell className="text-right text-sm font-medium">{s.period_total}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <div className="bg-card rounded-2xl border border-border overflow-hidden">
        <div className="p-4 border-b border-border">
          <h3 className="font-semibold text-foreground">Asistencia por colaborador</h3>
          <p className="text-xs text-muted-foreground">Horas trabajadas y días con marcaje</p>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="bg-secondary/50">
              <TableHead>Colaborador</TableHead>
              <TableHead>Rol</TableHead>
              <TableHead className="text-right">Días</TableHead>
              <TableHead className="text-right">Horas</TableHead>
              <TableHead className="text-right">Marcajes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(summary ?? []).length === 0 ? (
              <TableRow><TableCell colSpan={5} className="text-center py-6 text-muted-foreground">Sin datos en el periodo.</TableCell></TableRow>
            ) : (summary ?? []).map((e) => (
              <TableRow key={e.id}>
                <TableCell>
                  <div className="font-medium text-foreground">{e.full_name}</div>
                  <div className="text-xs text-muted-foreground font-mono">{e.employee_code}</div>
                </TableCell>
                <TableCell className="capitalize text-muted-foreground">{e.role}</TableCell>
                <TableCell className="text-right">{e.days_present}</TableCell>
                <TableCell className="text-right font-medium">{e.hours}</TableCell>
                <TableCell className="text-right text-muted-foreground">{e.marks}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function KPI({ label, value, accent }: { label: string; value: number; accent: "entry" | "exit" | "primary" | "muted" }) {
  const cls = {
    entry: "bg-[oklch(0.65_0.16_155)] text-white",
    exit: "bg-accent text-accent-foreground",
    primary: "bg-primary text-primary-foreground",
    muted: "bg-secondary text-foreground",
  }[accent];
  return (
    <div className={`rounded-2xl p-4 ${cls}`}>
      <div className="text-3xl font-bold leading-none">{value}</div>
      <div className="text-xs mt-2 opacity-90">{label}</div>
    </div>
  );
}

// =====================================================================
// TIENDAS
// =====================================================================
function StoresPanel() {
  const listFn = useServerFn(listStores);
  const createFn = useServerFn(createStore);
  const updateFn = useServerFn(updateStore);
  const deleteFn = useServerFn(deleteStore);
  const bulkFn = useServerFn(bulkCreateStores);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({ queryKey: ["stores"], queryFn: () => listFn() });
  const stores = data ?? [];

  const [open, setOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [editing, setEditing] = useState<(typeof stores)[number] | null>(null);
  const [form, setForm] = useState({ code: "", name: "", address: "", terminal_pin: "", active: true });
  const [geoForm, setGeoForm] = useState({ latitude: "", longitude: "", radius: "300" });

  useEffect(() => {
    if (editing) {
      setForm({
        code: editing.code,
        name: editing.name,
        address: editing.address ?? "",
        terminal_pin: "",
        active: editing.active,
      });
      const e = editing as { latitude?: number | null; longitude?: number | null; geofence_radius_m?: number | null };
      setGeoForm({
        latitude: e.latitude != null ? String(e.latitude) : "",
        longitude: e.longitude != null ? String(e.longitude) : "",
        radius: e.geofence_radius_m != null ? String(e.geofence_radius_m) : "300",
      });
    } else {
      setForm({ code: "", name: "", address: "", terminal_pin: "", active: true });
      setGeoForm({ latitude: "", longitude: "", radius: "300" });
    }
  }, [editing, open]);

  const save = async () => {
    try {
      const lat = geoForm.latitude.trim() === "" ? null : Number(geoForm.latitude);
      const lng = geoForm.longitude.trim() === "" ? null : Number(geoForm.longitude);
      const radius = Number(geoForm.radius) || 300;
      if ((lat !== null && Number.isNaN(lat)) || (lng !== null && Number.isNaN(lng))) {
        toast.error("Latitud/longitud inválida");
        return;
      }
      if (editing) {
        await updateFn({
          data: {
            id: editing.id,
            name: form.name,
            address: form.address || null,
            active: form.active,
            latitude: lat,
            longitude: lng,
            geofence_radius_m: radius,
            ...(form.terminal_pin ? { terminal_pin: form.terminal_pin } : {}),
          },
        });
        toast.success("Tienda actualizada");
      } else {
        if (!form.terminal_pin) {
          toast.error("El PIN de terminal es obligatorio");
          return;
        }
        await createFn({
          data: {
            code: form.code,
            name: form.name,
            address: form.address || null,
            terminal_pin: form.terminal_pin,
            active: form.active,
            latitude: lat,
            longitude: lng,
            geofence_radius_m: radius,
          },
        });
        toast.success("Tienda creada");
      }
      setOpen(false);
      setEditing(null);
      qc.invalidateQueries({ queryKey: ["stores"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error al guardar");
    }
  };

  const remove = async (id: string) => {
    if (!confirm("¿Eliminar esta tienda? Si tiene colaboradores o marcajes, fallará.")) return;
    try {
      await deleteFn({ data: { id } });
      toast.success("Tienda eliminada");
      qc.invalidateQueries({ queryKey: ["stores"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error al eliminar");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-bold text-foreground">Tiendas y áreas</h2>
          <p className="text-sm text-muted-foreground">{stores.length} registradas</p>
        </div>
        <div className="flex gap-2">
          <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
            <DialogTrigger asChild>
              <Button variant="outline">
                <Sparkles className="h-4 w-4 mr-2" /> Carga masiva
              </Button>
            </DialogTrigger>
            <BulkDialog
              onDone={() => { setBulkOpen(false); qc.invalidateQueries({ queryKey: ["stores"] }); }}
              bulkFn={bulkFn}
            />
          </Dialog>
          <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setEditing(null); }}>
            <DialogTrigger asChild>
              <Button className="bg-accent text-accent-foreground hover:bg-accent/90">
                <Plus className="h-4 w-4 mr-2" /> Nueva tienda
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{editing ? "Editar tienda" : "Nueva tienda"}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Código</Label>
                    <Input
                      disabled={!!editing}
                      value={form.code}
                      onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                      placeholder="Ej. A01, CEDI, CP"
                    />
                  </div>
                  <div>
                    <Label>{editing ? "PIN nuevo (vacío = mantener)" : "PIN terminal"}</Label>
                    <Input
                      inputMode="numeric"
                      pattern="\d*"
                      maxLength={8}
                      value={form.terminal_pin}
                      onChange={(e) => setForm({ ...form, terminal_pin: e.target.value.replace(/\D/g, "") })}
                      placeholder="4-8 dígitos"
                    />
                  </div>
                </div>
                <div>
                  <Label>Nombre</Label>
                  <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ej. Sucursal A01 Centro" />
                </div>
                <div>
                  <Label>Dirección (opcional)</Label>
                  <Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
                </div>
                <div className="border-t border-border pt-3">
                  <div className="flex items-center gap-2 mb-2">
                    <MapPin className="h-4 w-4 text-accent" />
                    <Label className="m-0">Geolocalización (opcional)</Label>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <Label className="text-xs">Latitud</Label>
                      <Input value={geoForm.latitude} onChange={(e) => setGeoForm({ ...geoForm, latitude: e.target.value })} placeholder="19.4326" />
                    </div>
                    <div>
                      <Label className="text-xs">Longitud</Label>
                      <Input value={geoForm.longitude} onChange={(e) => setGeoForm({ ...geoForm, longitude: e.target.value })} placeholder="-99.1332" />
                    </div>
                    <div>
                      <Label className="text-xs">Radio (m)</Label>
                      <Input value={geoForm.radius} onChange={(e) => setGeoForm({ ...geoForm, radius: e.target.value.replace(/\D/g, "") })} placeholder="300" />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">Saca lat/lng de Google Maps (clic derecho → copiar). Sin coords, no se valida ubicación.</p>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
                  Activa
                </label>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
                <Button onClick={save} className="bg-accent text-accent-foreground hover:bg-accent/90">Guardar</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="bg-card rounded-2xl border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-secondary/50">
              <TableHead>Código</TableHead>
              <TableHead>Nombre</TableHead>
              <TableHead>Dirección</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead className="text-right">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Cargando…</TableCell></TableRow>
            ) : stores.length === 0 ? (
              <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                Sin tiendas. Usa "Carga masiva" para crear A01–A95 de un solo paso.
              </TableCell></TableRow>
            ) : stores.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-mono text-foreground">{s.code}</TableCell>
                <TableCell className="font-medium text-foreground">{s.name}</TableCell>
                <TableCell className="text-muted-foreground text-sm">{s.address ?? "—"}</TableCell>
                <TableCell>
                  {s.active ? (
                    <Badge className="bg-[oklch(0.65_0.16_155)] text-white hover:bg-[oklch(0.65_0.16_155)]">Activa</Badge>
                  ) : (
                    <Badge variant="secondary">Inactiva</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => { setEditing(s); setOpen(true); }}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => remove(s.id)}>
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

function BulkDialog({
  onDone,
  bulkFn,
}: {
  onDone: () => void;
  bulkFn: ReturnType<typeof useServerFn<typeof bulkCreateStores>>;
}) {
  const [mode, setMode] = useState<"stores" | "support">("stores");
  const [prefix, setPrefix] = useState("A");
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(95);
  const [pad, setPad] = useState(2);
  const [namePrefix, setNamePrefix] = useState("Sucursal");
  const [supportCsv, setSupportCsv] = useState("MONITOREO:Monitoreo\nCEDI:Centro de Distribución\nCP:Centro de Producción");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);

  const preview = (): { code: string; name: string }[] => {
    if (mode === "stores") {
      const items: { code: string; name: string }[] = [];
      for (let i = from; i <= to; i++) {
        const num = String(i).padStart(pad, "0");
        items.push({ code: `${prefix}${num}`, name: `${namePrefix} ${prefix}${num}` });
      }
      return items;
    }
    return supportCsv.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
      const [code, ...rest] = line.split(":");
      return { code: (code || "").trim().toUpperCase(), name: (rest.join(":").trim()) || (code || "").trim() };
    }).filter((x) => x.code);
  };

  const run = async () => {
    const items = preview();
    if (items.length === 0) { toast.error("Sin elementos a crear"); return; }
    if (!/^\d{4,8}$/.test(pin)) { toast.error("PIN inválido (4–8 dígitos)"); return; }
    setBusy(true);
    try {
      const r = await bulkFn({ data: { items, terminal_pin: pin } });
      toast.success(`Creadas: ${r.created} · Existentes: ${r.skipped}`);
      onDone();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error en carga masiva");
    } finally {
      setBusy(false);
    }
  };

  const items = preview();

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Carga masiva de tiendas/áreas</DialogTitle>
      </DialogHeader>
      <div className="space-y-3">
        <div className="flex gap-2">
          <Button variant={mode === "stores" ? "default" : "outline"} size="sm" onClick={() => setMode("stores")}>
            Tiendas (rango)
          </Button>
          <Button variant={mode === "support" ? "default" : "outline"} size="sm" onClick={() => setMode("support")}>
            Áreas de apoyo
          </Button>
        </div>

        {mode === "stores" ? (
          <>
            <div className="grid grid-cols-4 gap-2">
              <div><Label>Prefijo</Label><Input value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} /></div>
              <div><Label>Desde</Label><Input type="number" value={from} onChange={(e) => setFrom(Number(e.target.value))} /></div>
              <div><Label>Hasta</Label><Input type="number" value={to} onChange={(e) => setTo(Number(e.target.value))} /></div>
              <div><Label>Dígitos</Label><Input type="number" value={pad} onChange={(e) => setPad(Number(e.target.value))} /></div>
            </div>
            <div>
              <Label>Prefijo de nombre</Label>
              <Input value={namePrefix} onChange={(e) => setNamePrefix(e.target.value)} placeholder="Ej. Sucursal" />
            </div>
          </>
        ) : (
          <div>
            <Label>Áreas (una por línea, formato CODIGO:Nombre)</Label>
            <textarea
              className="w-full mt-1 border border-border rounded-md p-2 text-sm bg-background min-h-[120px] font-mono"
              value={supportCsv}
              onChange={(e) => setSupportCsv(e.target.value)}
            />
          </div>
        )}

        <div>
          <Label>PIN de terminal (compartido para este lote)</Label>
          <Input
            inputMode="numeric"
            maxLength={8}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            placeholder="4-8 dígitos"
          />
        </div>

        <div className="text-xs text-muted-foreground">
          Se crearán <span className="font-semibold text-foreground">{items.length}</span> elementos.
          {items.length > 0 && (
            <span> Ej: <span className="font-mono">{items[0].code}</span> · {items[0].name}
              {items.length > 1 && <> … <span className="font-mono">{items[items.length - 1].code}</span></>}
            </span>
          )}
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={busy}>Cancelar</Button>
        <Button onClick={run} disabled={busy} className="bg-accent text-accent-foreground hover:bg-accent/90">
          {busy ? "Creando…" : `Crear ${items.length}`}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
function FingerprintButton({ employeeId, employeeName }: { employeeId: string; employeeName: string }) {
  const beginFn = useServerFn(beginWebauthnRegistration);
  const finishFn = useServerFn(finishWebauthnRegistration);
  const listFn = useServerFn(listEmployeeCredentials);
  const deleteFn = useServerFn(deleteEmployeeCredential);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [creds, setCreds] = useState<Array<{ id: string; device_label: string | null; created_at: string; last_used_at: string | null }>>([]);

  const refresh = async () => {
    try { setCreds(await listFn({ data: { employeeId } })); } catch { /* noop */ }
  };

  useEffect(() => { if (open) void refresh(); /* eslint-disable-next-line */ }, [open]);

  const register = async () => {
    setBusy(true);
    try {
      const opts = await beginFn({ data: { employeeId } });
      const att = await startRegistration({ optionsJSON: opts as Parameters<typeof startRegistration>[0]["optionsJSON"] });
      const label = navigator.userAgent.includes("Mobile") ? "Móvil" : "Escritorio";
      const res = await finishFn({ data: { employeeId, response: att, deviceLabel: label } });
      if (!res.ok) toast.error(res.error);
      else { toast.success("Huella registrada"); await refresh(); }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Cancelado o no soportado");
    } finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    if (!confirm("¿Eliminar esta huella?")) return;
    await deleteFn({ data: { id } });
    await refresh();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" title="Huellas registradas"><Fingerprint className="h-4 w-4" /></Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Huellas de {employeeName}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">Cada huella queda atada al dispositivo donde se registra. Pídele al colaborador que apoye el dedo cuando lo solicite el sistema.</p>
        <Button onClick={register} disabled={busy} className="bg-accent text-accent-foreground hover:bg-accent/90">
          <Fingerprint className="h-4 w-4 mr-2" /> {busy ? "Esperando…" : "Registrar huella en este dispositivo"}
        </Button>
        <div className="space-y-2">
          {creds.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-3">Sin huellas registradas.</p>
          ) : creds.map((c) => (
            <div key={c.id} className="flex items-center justify-between bg-secondary rounded-lg px-3 py-2">
              <div className="text-sm">
                <div className="font-medium">{c.device_label ?? "Dispositivo"}</div>
                <div className="text-xs text-muted-foreground">Registrada {new Date(c.created_at).toLocaleDateString("es-MX")}</div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => remove(c.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
