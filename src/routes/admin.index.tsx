import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listEmployees,
  listAttendance,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  resetEmployeePin,
  listEmployeeAssignments,
  setEmployeeAssignments,
  checkAdmin,
  listAdminUsers,
  upsertAdminUser,
  removeAdminRole,
  setUserZones,
  setUserStores,
  seedZoneManagers,
  seedOperationsManager,
  seedStoreManagers,
  seedExtraSuperAdmins,
} from "@/lib/admin.functions";
import {
  listStores,
  createStore,
  updateStore,
  deleteStore,
  bulkCreateStores,
  setStoreTerminalPin,
  resetManagerPassword,
} from "@/lib/stores.functions";
import {
  listZones,
  createZone,
  updateZone,
  deleteZone,
} from "@/lib/zones.functions";
import {
  beginWebauthnRegistration,
  finishWebauthnRegistration,
  listEmployeeCredentials,
  deleteEmployeeCredential,
} from "@/lib/webauthn.functions";
import { startRegistration } from "@simplewebauthn/browser";
import { getDashboardMetrics, getEmployeeSummary, getEmployeeWeeklyMarks, getWeeklySchedule, exportAttendance, getStaffingReport, getAttendanceKpis } from "@/lib/dashboard.functions";
import { SelfieCapture } from "@/components/SelfieCapture";
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
  Map as MapZoneIcon, ShieldCheck, Calendar as CalendarIcon, ChevronRight, Camera, KeyRound, ClipboardList,
  ClipboardCheck,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/")({
  component: AdminDashboard,
});

type EmployeeRole =
  | "cajero"
  | "gerente"
  | "seguridad"
  | "agente_mbk"
  | "gerente_zona"
  | "personal_limpieza"
  | "seguridad_interna"
  | "seguridad_tercerizada";

const ROLE_LABELS: Record<EmployeeRole, string> = {
  cajero: "Cajero",
  agente_mbk: "Agente MBK",
  personal_limpieza: "Personal de Limpieza",
  seguridad_interna: "Seguridad Interna",
  seguridad_tercerizada: "Seguridad Tercerizada",
  seguridad: "Seguridad",
  gerente: "Gerente",
  gerente_zona: "Gerente de Zona",
};

const ADMIN_ROLE_LABELS: Record<string, string> = {
  admin: "Administrador",
  gerente_operaciones: "Gerente de Operaciones",
  gerente_zona: "Gerente de Zona (Admin)",
  gerente_tienda: "Gerente de Tienda",
};

/**
 * Filtro reutilizable por Zona y Tienda. Deriva las opciones de listStores
 * (ya limitado al alcance del usuario). Solo se muestra si hay más de una tienda
 * (un GT con una sola tienda no lo necesita).
 */
function useStoreFilter() {
  const storesFn = useServerFn(listStores);
  const { data } = useQuery({ queryKey: ["stores"], queryFn: () => storesFn() });
  const storeList = data ?? [];
  const [zoneId, setZoneId] = useState("all");
  const [storeId, setStoreId] = useState("all");

  const zones = useMemo(() => {
    const m = new Map<string, { id: string; label: string }>();
    for (const s of storeList) {
      const zRaw = (s as { zones?: { code?: string; name?: string } | { code?: string; name?: string }[] }).zones;
      const z = Array.isArray(zRaw) ? zRaw[0] : zRaw;
      if (s.zone_id && z) m.set(s.zone_id, { id: s.zone_id, label: `${z.code ?? ""} · ${z.name ?? ""}` });
    }
    return [...m.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [storeList]);

  const storesForZone = zoneId === "all" ? storeList : storeList.filter((s) => s.zone_id === zoneId);

  const matches = (sid?: string | null) => {
    if (storeId !== "all") return sid === storeId;
    if (zoneId !== "all") return storesForZone.some((s) => s.id === sid);
    return true;
  };

  const bar = storeList.length > 1 ? (
    <div className="flex flex-wrap items-center gap-2">
      {zones.length > 1 && (
        <Select value={zoneId} onValueChange={(v) => { setZoneId(v); setStoreId("all"); }}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Zona" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas las zonas</SelectItem>
            {zones.map((z) => <SelectItem key={z.id} value={z.id}>{z.label}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
      <Select value={storeId} onValueChange={setStoreId}>
        <SelectTrigger className="w-52"><SelectValue placeholder="Tienda" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Todas las tiendas</SelectItem>
          {storesForZone.map((s) => <SelectItem key={s.id} value={s.id}>{s.code} · {s.name}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  ) : null;

  return { zoneId, storeId, matches, bar };
}

function AdminDashboard() {
  const checkFn = useServerFn(checkAdmin);
  const { data: access } = useQuery({ queryKey: ["adminAccess"], queryFn: () => checkFn() });
  const canManageOrg = !!(access?.isAdmin || access?.isOperations);
  const canSeeStores = canManageOrg || !!access?.isZoneAdmin;
  return (
    <Tabs defaultValue="dashboard" className="space-y-4">
      <TabsList className="bg-card border border-border flex-wrap h-auto">
        <TabsTrigger value="dashboard" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">
          <LayoutDashboard className="h-4 w-4 mr-2" />
          Dashboard
        </TabsTrigger>
        <TabsTrigger value="schedule" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">
          <CalendarIcon className="h-4 w-4 mr-2" />
          Horario
        </TabsTrigger>
        <TabsTrigger value="staffing" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">
          <ClipboardList className="h-4 w-4 mr-2" />
          Dotación
        </TabsTrigger>
        <TabsTrigger value="kpis" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">
          <ClipboardCheck className="h-4 w-4 mr-2" />
          Evaluación
        </TabsTrigger>
        <TabsTrigger value="attendance" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">
          <History className="h-4 w-4 mr-2" />
          Marcajes
        </TabsTrigger>
        <TabsTrigger value="employees" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">
          <Users className="h-4 w-4 mr-2" />
          Colaboradores
        </TabsTrigger>
        {canSeeStores && (
          <TabsTrigger value="stores" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">
            <StoreIcon className="h-4 w-4 mr-2" />
            Tiendas
          </TabsTrigger>
        )}
        {canManageOrg && (
          <TabsTrigger value="zones" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">
            <MapZoneIcon className="h-4 w-4 mr-2" />
            Zonas
          </TabsTrigger>
        )}
        {canManageOrg && (
          <TabsTrigger value="admins" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">
            <ShieldCheck className="h-4 w-4 mr-2" />
            Usuarios admin
          </TabsTrigger>
        )}
      </TabsList>
      <TabsContent value="dashboard">
        <DashboardPanel />
      </TabsContent>
      <TabsContent value="schedule">
        <WeeklySchedulePanel />
      </TabsContent>
      <TabsContent value="staffing">
        <StaffingPanel />
      </TabsContent>
      <TabsContent value="kpis">
        <KpiPanel />
      </TabsContent>
      <TabsContent value="attendance">
        <AttendancePanel />
      </TabsContent>
      <TabsContent value="employees">
        <EmployeesPanel />
      </TabsContent>
      {canSeeStores && (
        <TabsContent value="stores">
          {canManageOrg ? <StoresPanel /> : <ZoneStoresPanel />}
        </TabsContent>
      )}
      {canManageOrg && (
        <TabsContent value="zones">
          <ZonesPanel />
        </TabsContent>
      )}
      {canManageOrg && (
        <TabsContent value="admins">
          <AdminUsersPanel isAdmin={!!access?.isAdmin} />
        </TabsContent>
      )}
    </Tabs>
  );
}

function AttendancePanel() {
  const fetchFn = useServerFn(listAttendance);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["attendance"],
    queryFn: () => fetchFn({ data: { limit: 200 } }),
    refetchInterval: 15_000,
    retry: 1,
  });

  const filter = useStoreFilter();
  const rows = (data ?? []).filter((r) => filter.matches(r.store_id));

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
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-foreground">Historial de marcajes</h2>
          <p className="text-sm text-muted-foreground">Últimos {rows.length} registros (se actualiza cada 15s)</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {filter.bar}
          <Button onClick={exportCsv} variant="outline" disabled={rows.length === 0}>
            <Download className="h-4 w-4 mr-2" /> Exportar CSV
          </Button>
        </div>
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
            {isError ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-destructive">
                  No se pudieron cargar los marcajes: {error instanceof Error ? error.message : "error desconocido"}
                </TableCell>
              </TableRow>
            ) : isLoading ? (
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
                      {r.notes && <div className="text-xs text-purple-700 mt-0.5">{r.notes}</div>}
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
  const resetPinFn = useServerFn(resetEmployeePin);
  const storesFn = useServerFn(listStores);
  const checkFn = useServerFn(checkAdmin);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["employees"],
    queryFn: () => fetchFn(),
  });
  const { data: stores } = useQuery({ queryKey: ["stores"], queryFn: () => storesFn() });
  const { data: access } = useQuery({ queryKey: ["adminAccess"], queryFn: () => checkFn() });

  // Un Gerente de Tienda "puro" (sin admin/ops/zona) tiene permisos limitados.
  const isOnlyStoreAdmin =
    !!access?.isStoreAdmin && !access?.isAdmin && !access?.isOperations && !access?.isZoneAdmin;
  const isSuper = !!(access?.isAdmin || access?.isOperations);
  const isZoneOnly = !!access?.isZoneAdmin && !isSuper;
  // Quién puede restablecer el PIN de cada colaborador (refleja la regla del backend):
  //  - Super admin/Ops: todos.  - GZ: todos menos otro GZ.  - GT: solo sus Agentes.
  const canResetPin = (role: string) => {
    if (isSuper) return true;
    if (isZoneOnly) return role !== "gerente_zona";
    if (isOnlyStoreAdmin) return ["cajero", "agente_mbk", "personal_limpieza", "seguridad_interna", "seguridad_tercerizada", "seguridad"].includes(role);
    return false;
  };
  const allowedRoles: EmployeeRole[] = isOnlyStoreAdmin
    ? ["cajero", "agente_mbk", "personal_limpieza", "seguridad_interna", "seguridad_tercerizada"]
    : ["cajero", "agente_mbk", "personal_limpieza", "seguridad_interna", "seguridad_tercerizada", "gerente", "gerente_zona"];

  const filter = useStoreFilter();
  const employees = (data ?? []).filter((e) => filter.matches(e.store_id));
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
    face_descriptor: null as number[] | null,
  });
  const [showRefCapture, setShowRefCapture] = useState(false);

  useEffect(() => {
    if (editing) {
      setForm({
        employee_code: editing.employee_code,
        full_name: editing.full_name,
        role: editing.role as EmployeeRole,
        store_id: editing.store_id ?? "",
        pin: "",
        active: editing.active,
        face_descriptor: null,
      });
    } else {
      setForm({
        employee_code: "",
        full_name: "",
        role: "cajero",
        store_id: storeList[0]?.id ?? "",
        pin: "",
        active: true,
        face_descriptor: null,
      });
    }
    setShowRefCapture(false);
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
            ...(form.face_descriptor ? { face_descriptor: form.face_descriptor } : {}),
          },
        });
        toast.success("Colaborador actualizado");
      } else {
        // La Seguridad Tercerizada usa un usuario compartido por tienda (rota el
        // personal), por eso no exige foto de referencia.
        if (!form.face_descriptor && form.role !== "seguridad_tercerizada") {
          toast.error("Toma la foto de referencia del colaborador (reconocimiento facial)");
          return;
        }
        await createFn({
          data: {
            employee_code: form.employee_code,
            full_name: form.full_name,
            role: form.role,
            store_id: form.store_id,
            pin: form.pin,
            active: form.active,
            ...(form.face_descriptor ? { face_descriptor: form.face_descriptor } : {}),
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

  const resetPin = async (id: string, name: string) => {
    if (!confirm(`¿Restablecer el PIN de ${name} a 1234?\nDeberá crear un PIN nuevo en su próximo marcaje.`)) return;
    try {
      await resetPinFn({ data: { id } });
      toast.success(`PIN restablecido a 1234. ${name} deberá cambiarlo al marcar.`);
      qc.invalidateQueries({ queryKey: ["employees"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error al restablecer el PIN");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-foreground">Colaboradores</h2>
          <p className="text-sm text-muted-foreground">{employees.length} registrados</p>
        </div>
        {filter.bar}
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
                      {allowedRoles.map((r) => (
                        <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>{form.role === "gerente_zona" ? "Tienda base (inicial)" : "Tienda"}</Label>
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
              {form.role === "gerente_zona" && editing && (
                <ZoneAssignmentsEditor
                  employeeId={editing.id}
                  stores={storeList.map((s) => ({ id: s.id, code: s.code, name: s.name }))}
                />
              )}
              {form.role === "gerente_zona" && !editing && (
                <p className="text-xs text-muted-foreground bg-secondary/60 rounded-lg p-2">
                  Crea primero al Gerente de Zona y luego edítalo para asignarle las tiendas que supervisará.
                </p>
              )}
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
              <div className="rounded-lg border border-border p-3 space-y-2">
                <Label>Foto de referencia (reconocimiento facial)</Label>
                {showRefCapture ? (
                  <SelfieCapture
                    requireDescriptor
                    confirmLabel="Usar esta foto"
                    onCapture={(_url, desc) => {
                      setForm((f) => ({ ...f, face_descriptor: desc }));
                      setShowRefCapture(false);
                    }}
                    onCancel={() => setShowRefCapture(false)}
                  />
                ) : form.face_descriptor ? (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-[oklch(0.55_0.14_155)] font-medium">✓ Rostro de referencia capturado</span>
                    <Button type="button" variant="outline" size="sm" onClick={() => setShowRefCapture(true)}>
                      Volver a tomar
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      {editing
                        ? "Opcional: re-capturar para actualizar."
                        : form.role === "seguridad_tercerizada"
                          ? "No requerida: la Seguridad Tercerizada usa un usuario compartido por tienda (rota el personal); la selfie de cada marcaje queda como evidencia."
                          : "Obligatoria: se usará para validar su identidad al marcar."}
                    </span>
                    <Button type="button" variant="outline" size="sm" onClick={() => setShowRefCapture(true)}>
                      <Camera className="h-4 w-4 mr-1" /> Tomar foto
                    </Button>
                  </div>
                )}
              </div>
              <p className="text-xs text-muted-foreground">El colaborador marcará entrada/salida con PIN + Huella. Registra la huella después con el botón <span className="inline-flex items-center gap-1"><Fingerprint className="h-3 w-3" /></span> en la lista. Los accesos de Administrador, Gerente de Operaciones y Gerente de Zona se gestionan en la pestaña <strong>Usuarios admin</strong>.</p>
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
                <TableCell className="text-muted-foreground">{ROLE_LABELS[e.role as EmployeeRole] ?? e.role}</TableCell>
                <TableCell className="text-muted-foreground">
                  {(() => {
                    const s = storeList.find((x) => x.id === e.store_id);
                    return s ? `${s.code} · ${s.name}` : (e.store ?? "—");
                  })()}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {e.active ? (
                      <Badge className="bg-[oklch(0.65_0.16_155)] text-white hover:bg-[oklch(0.65_0.16_155)]">Activo</Badge>
                    ) : (
                      <Badge variant="secondary">Inactivo</Badge>
                    )}
                    {e.must_change_pin && (
                      <Badge variant="outline" className="border-amber-500 text-amber-700">PIN 1234 · por cambiar</Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <FingerprintButton employeeId={e.id} employeeName={e.full_name} />
                  {canResetPin(e.role) && (
                    <Button variant="ghost" size="sm" title="Restablecer PIN a 1234" onClick={() => resetPin(e.id, e.full_name)}>
                      <KeyRound className="h-4 w-4 text-amber-600" />
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => { setEditing(e); setOpen(true); }}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  {(!isOnlyStoreAdmin || ["cajero", "agente_mbk", "personal_limpieza", "seguridad_interna", "seguridad_tercerizada", "seguridad"].includes(e.role)) && (
                    <Button variant="ghost" size="sm" onClick={() => remove(e.id)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
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
function ZoneAssignmentsEditor({
  employeeId,
  stores,
}: {
  employeeId: string;
  stores: { id: string; code: string; name: string }[];
}) {
  const listFn = useServerFn(listEmployeeAssignments);
  const setFn = useServerFn(setEmployeeAssignments);
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["empAssignments", employeeId],
    queryFn: () => listFn({ data: { employee_id: employeeId } }),
  });
  const [selected, setSelected] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (data && selected === null) {
      setSelected(new Set(data.map((r) => r.store_id)));
    }
  }, [data, selected]);

  const toggle = (id: string) => {
    const next = new Set(selected ?? []);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const save = async () => {
    try {
      await setFn({ data: { employee_id: employeeId, store_ids: Array.from(selected ?? []) } });
      toast.success("Tiendas asignadas actualizadas");
      qc.invalidateQueries({ queryKey: ["empAssignments", employeeId] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error al asignar tiendas");
    }
  };

  return (
    <div className="rounded-xl border border-border p-3 bg-secondary/40 space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-sm">Tiendas que supervisa</Label>
        <Button size="sm" variant="outline" onClick={save} disabled={isLoading || selected === null}>
          Guardar asignaciones
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        El Gerente de Zona podrá marcar entrada/salida en cualquiera de las tiendas seleccionadas.
      </p>
      <div className="max-h-40 overflow-y-auto grid grid-cols-1 gap-1">
        {stores.map((s) => {
          const checked = selected?.has(s.id) ?? false;
          return (
            <label key={s.id} className="flex items-center gap-2 text-sm py-1">
              <input type="checkbox" checked={checked} onChange={() => toggle(s.id)} />
              <span className="font-mono text-xs text-muted-foreground">{s.code}</span>
              <span className="text-foreground">{s.name}</span>
            </label>
          );
        })}
        {stores.length === 0 && <p className="text-xs text-muted-foreground">No hay tiendas registradas.</p>}
      </div>
    </div>
  );
}

// =====================================================================
// DOTACIÓN: Real vs Plan
// =====================================================================
function todayNI(): string {
  return new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
}

function DotCell({ c }: { c: { real: number; plan: number; names: string[] } }) {
  const color = c.plan === 0 ? "text-muted-foreground" : c.real >= c.plan ? "text-[oklch(0.55_0.14_155)]" : "text-amber-700";
  return (
    <div className="min-w-0">
      <span className={`font-semibold ${color}`}>{c.real}/{c.plan}</span>
      {c.names.length > 0 && (
        <ul className="mt-0.5 space-y-0.5 text-xs text-muted-foreground">
          {c.names.map((n, i) => (
            <li key={i} className="leading-tight break-words">{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StaffingPanel() {
  const reportFn = useServerFn(getStaffingReport);
  const filter = useStoreFilter();
  const [date, setDate] = useState(todayNI());
  const [shift, setShift] = useState<"am" | "pm">("am");

  const args: { date: string; storeId?: string; zoneId?: string } = { date };
  if (filter.storeId !== "all") args.storeId = filter.storeId;
  else if (filter.zoneId !== "all") args.zoneId = filter.zoneId;

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["staffing", date, filter.zoneId, filter.storeId],
    queryFn: () => reportFn({ data: args }),
  });
  const rows = data?.rows ?? [];

  const exportCsv = () => {
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const cellTxt = (c: { real: number; plan: number; names: string[] }) =>
      `${c.real}/${c.plan}${c.names.length ? " — " + c.names.join("; ") : ""}`;
    const lbl = shift === "am" ? "AM" : "PM";
    const header = ["Tienda", "Nombre", `Productos ${lbl}`, `MBK ${lbl}`, "Real", "Plan", "%"];
    const lines = [header.join(",")].concat(
      rows.map((r) => {
        const p = shift === "am" ? r.prod.am : r.prod.pm;
        const m = shift === "am" ? r.mbk.am : r.mbk.pm;
        const real = p.real + m.real, plan = p.plan + m.plan;
        return [r.code, esc(r.name), esc(cellTxt(p)), esc(cellTxt(m)), String(real), String(plan), plan ? `${Math.round((real / plan) * 100)}%` : "—"].join(",");
      }),
    );
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `dotacion_${shift}_${date}.csv`; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-foreground">Dotación: Real vs Plan</h2>
          <p className="text-sm text-muted-foreground">
            Agentes que marcaron entrada vs el plan. Útil después de las 6:59am para validar el turno AM.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {filter.bar}
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value || todayNI())} className="w-40" />
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={rows.length === 0}>
            <Download className="h-4 w-4 mr-1" /> Exportar Excel
          </Button>
        </div>
      </div>
      <Tabs value={shift} onValueChange={(v) => setShift(v as "am" | "pm")}>
        <TabsList className="bg-secondary border border-border">
          <TabsTrigger value="am" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">Corte AM</TabsTrigger>
          <TabsTrigger value="pm" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">Corte PM</TabsTrigger>
        </TabsList>
        {(["am", "pm"] as const).map((s) => (
          <TabsContent key={s} value={s} className="mt-3">
            <div className="bg-card rounded-2xl border border-border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-secondary/50">
                    <TableHead>Tienda</TableHead>
                    <TableHead>Productos {s === "am" ? "AM" : "PM"}</TableHead>
                    <TableHead>MBK {s === "am" ? "AM" : "PM"}</TableHead>
                    <TableHead className="text-right">Real</TableHead>
                    <TableHead className="text-right">Plan</TableHead>
                    <TableHead className="text-right">%</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isError ? (
                    <TableRow><TableCell colSpan={6} className="text-center py-8 text-destructive">{error instanceof Error ? error.message : "Error"}</TableCell></TableRow>
                  ) : isLoading ? (
                    <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Cargando…</TableCell></TableRow>
                  ) : rows.length === 0 ? (
                    <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Sin tiendas en alcance.</TableCell></TableRow>
                  ) : rows.map((r) => {
                    const p = s === "am" ? r.prod.am : r.prod.pm;
                    const m = s === "am" ? r.mbk.am : r.mbk.pm;
                    const real = p.real + m.real;
                    const plan = p.plan + m.plan;
                    const pct = plan ? Math.round((real / plan) * 100) : 0;
                    return (
                      <TableRow key={r.id}>
                        <TableCell><span className="font-mono text-foreground">{r.code}</span> <span className="text-muted-foreground text-xs">{r.name}</span></TableCell>
                        <TableCell><DotCell c={p} /></TableCell>
                        <TableCell><DotCell c={m} /></TableCell>
                        <TableCell className="text-right font-medium">{real}</TableCell>
                        <TableCell className="text-right text-muted-foreground">{plan}</TableCell>
                        <TableCell className={`text-right font-semibold ${pct >= 100 ? "text-[oklch(0.55_0.14_155)]" : "text-amber-700"}`}>{plan ? pct + "%" : "—"}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </TabsContent>
        ))}
      </Tabs>
      <p className="text-xs text-muted-foreground">
        Productos = cajeros; MBK = Agente MBK. <strong>Real</strong> = quienes marcaron entrada en ese corte; <strong>Plan</strong> = meta según el presupuesto y el día. Verde = cumple, ámbar = falta. <strong>Exportar Excel</strong> baja el corte seleccionado.
      </p>
    </div>
  );
}

// =====================================================================
// EVALUACIÓN: KPI de Asistencia y Puntualidad (caja/MBK)
// =====================================================================
/** Sábado (yyyy-mm-dd) que inicia la semana de evaluación (Sáb→Vie) que contiene la fecha. */
function evalWeekStart(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const back = (d.getUTCDay() + 1) % 7; // Sáb=6→0, Dom=0→1, … Vie=5→6
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}
/** Turnos finalizados mínimos para nota completa (Productos 4, MBK 6). */
function minTurnos(role: string): number {
  return role === "MBK" ? 6 : 4;
}
type KpiState = "complete" | "building" | "nodata";
/** Estado de la nota: la nota se CONSTRUYE día a día. "complete" cuando se cumple el
 * mínimo de turnos (semana madura); "building" mientras se va llenando; "nodata" sin
 * marcajes que evaluar. La nota se muestra desde el primer turno (no se bloquea). */
function kpiState(finalizados: number, turnos: number, role: string): KpiState {
  if (turnos <= 0) return "nodata";
  return finalizados >= minTurnos(role) ? "complete" : "building";
}
/** Avance del corte: % de turnos finalizados sobre los esperados (4 Productos / 6 MBK).
 * Ej.: 2 de 4 = 50%. Llega a 100% cuando se cumple el mínimo para calificar. */
function avancePct(finalizados: number, role: string): number {
  return Math.min(100, Math.round((finalizados / minTurnos(role)) * 100));
}
function AvanceBadge({ pct }: { pct: number }) {
  const cls =
    pct >= 100 ? "bg-emerald-100 text-emerald-800 border-emerald-200"
    : pct >= 50 ? "bg-amber-100 text-amber-800 border-amber-200"
    : "bg-muted text-muted-foreground border-border";
  return <span className={`inline-flex items-center rounded-full border px-2 h-7 text-sm font-bold ${cls}`}>{pct}%</span>;
}

function ScoreBadge({ n }: { n: number }) {
  const cls =
    n >= 5 ? "bg-emerald-100 text-emerald-800 border-emerald-200"
    : n === 4 ? "bg-green-100 text-green-800 border-green-200"
    : n === 3 ? "bg-amber-100 text-amber-800 border-amber-200"
    : "bg-red-100 text-red-800 border-red-200";
  return <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full border text-sm font-bold ${cls}`}>{n}</span>;
}

function KpiPanel() {
  const kpiFn = useServerFn(getAttendanceKpis);
  const filter = useStoreFilter();
  const [weekStart, setWeekStart] = useState(() => addDaysISO(evalWeekStart(todayNI()), -7));
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const args: { weekStart: string; storeId?: string; zoneId?: string } = { weekStart };
  if (filter.storeId !== "all") args.storeId = filter.storeId;
  else if (filter.zoneId !== "all") args.zoneId = filter.zoneId;

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["kpis", weekStart, filter.zoneId, filter.storeId],
    queryFn: () => kpiFn({ data: args }),
  });
  const rows = data?.rows ?? [];
  const weekEnd = addDaysISO(weekStart, 6);

  const exportCsv = () => {
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const header = ["Tienda", "Colaborador", "Área", "Turnos finalizados", "Mínimo", "Avance % del corte", "Estado nota", "Incid. puntualidad", "Nota puntualidad", "Olvidos", "Ajustes", "Nota marcaje"];
    const estadoLbl: Record<KpiState, string> = { complete: "Completa", building: "En construcción", nodata: "Sin datos" };
    const lines = [header.join(",")].concat(
      rows.map((r) => {
        const state = kpiState(r.finalizados, r.turnos, r.role);
        const showNota = state !== "nodata";
        return [r.store, esc(r.name), r.role, r.finalizados, minTurnos(r.role), `${avancePct(r.finalizados, r.role)}%`, estadoLbl[state], r.incidencias, showNota ? r.scorePuntualidad : "", r.olvidos, r.ajustes, showNota ? r.scoreMarcaje : ""].join(",");
      }),
    );
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `kpi_asistencia_${weekStart}.csv`; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-foreground">KPI de Asistencia y Puntualidad</h2>
          <p className="text-sm text-muted-foreground">Para la evaluación semanal de caja y MBK. Nota sugerida 1-5 por KPI.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {filter.bar}
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" onClick={() => setWeekStart(addDaysISO(weekStart, -7))}>‹</Button>
            <span className="text-sm font-medium tabular-nums w-24 text-center">{fmtDM(weekStart)} – {fmtDM(weekEnd)}</span>
            <Button variant="outline" size="sm" onClick={() => setWeekStart(addDaysISO(weekStart, 7))}>›</Button>
          </div>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={rows.length === 0}>
            <Download className="h-4 w-4 mr-1" /> Exportar Excel
          </Button>
        </div>
      </div>
      <div className="bg-card rounded-2xl border border-border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-secondary/50">
              <TableHead>Colaborador</TableHead>
              <TableHead>Tienda</TableHead>
              <TableHead>Área</TableHead>
              <TableHead className="text-center">Turnos fin.</TableHead>
              <TableHead className="text-center">Puntualidad</TableHead>
              <TableHead className="text-center">Marcaje correcto</TableHead>
              <TableHead className="text-center">Avance<br/><span className="text-xs font-normal text-muted-foreground">% del corte</span></TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isError ? (
              <TableRow><TableCell colSpan={8} className="text-center py-8 text-destructive">{error instanceof Error ? error.message : "Error"}</TableCell></TableRow>
            ) : isLoading ? (
              <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">Cargando…</TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">Sin marcajes de caja/MBK en esta semana.</TableCell></TableRow>
            ) : rows.map((r) => {
              const min = minTurnos(r.role);
              const state = kpiState(r.finalizados, r.turnos, r.role);
              const showNota = state !== "nodata";
              const building = state === "building";
              return (
              <Fragment key={r.employeeId}>
                <TableRow className={state === "nodata" ? "opacity-70" : ""}>
                  <TableCell className="font-medium">
                    {r.name}
                    {building && <div className="text-[11px] text-amber-700">En construcción ({r.finalizados}/{min})</div>}
                    {state === "nodata" && <div className="text-[11px] text-muted-foreground">Sin marcajes</div>}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.store}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.role}</TableCell>
                  <TableCell className="text-center">
                    <span className={state === "complete" ? "font-medium" : "text-amber-700 font-semibold"}>{r.finalizados}</span>
                    <span className="text-muted-foreground text-xs">/{min}</span>
                  </TableCell>
                  <TableCell className="text-center">
                    {showNota ? (
                      <><span className="text-muted-foreground text-xs mr-2">{r.incidencias} incid.</span><ScoreBadge n={r.scorePuntualidad} /></>
                    ) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-center">
                    {showNota ? (
                      <><span className="text-muted-foreground text-xs mr-2">{r.olvidos} olv. / {r.ajustes} aj.</span><ScoreBadge n={r.scoreMarcaje} /></>
                    ) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-center">
                    <AvanceBadge pct={avancePct(r.finalizados, r.role)} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => setOpen((o) => ({ ...o, [r.employeeId]: !o[r.employeeId] }))}>
                      {open[r.employeeId] ? "Ocultar" : "Detalle"}
                    </Button>
                  </TableCell>
                </TableRow>
                {open[r.employeeId] && (
                  <TableRow className="bg-secondary/30">
                    <TableCell colSpan={8} className="text-xs space-y-2">
                      {building && (
                        <div className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-amber-800">
                          ℹ️ <strong>Nota en construcción:</strong> se actualiza cada día/turno. Va por {r.finalizados} de {min} turnos finalizados; al llegar a {min} la semana queda completa. Si faltan turnos al cierre, el GT revisa si es justificado (Ausencias) y define la nota final.
                        </div>
                      )}
                      {state === "nodata" && (
                        <div className="rounded-md border border-border bg-muted/40 px-2 py-1 text-muted-foreground">
                          Sin marcajes registrados en esta semana.
                        </div>
                      )}
                      {r.detalle.length === 0 ? (
                        <span className="text-muted-foreground">Sin entradas registradas esta semana.</span>
                      ) : (
                        <div className="flex flex-wrap gap-2 py-1">
                          {r.detalle.map((d, i) => (
                            <span
                              key={i}
                              className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 ${d.tarde ? "bg-red-50 border-red-200 text-red-800" : "bg-emerald-50 border-emerald-200 text-emerald-800"}`}
                            >
                              {fmtDM(d.date)} {d.turno} · {d.hora}
                              {d.tarde ? ` (+${d.atraso}m tarde)` : " ✓"}
                            </span>
                          ))}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        <strong>Semana Sáb→Vie</strong> (cierra el sábado de madrugada, sin partir el turno nocturno). <strong>La nota se construye día a día</strong>: cada turno marcado actualiza Puntualidad y Marcaje al instante. Aparece <em>"En construcción"</em> mientras la semana avanza y queda <strong>completa</strong> al llegar a 4 turnos (Productos) o 6 (MBK). Un turno en curso (sin salida aún) no cuenta como olvido hasta pasadas 14h.{" "}
        <strong>Puntualidad</strong>: incidencia = llegada &gt;5 min después del inicio (Productos AM 6:00 / PM 18:00; MBK AM 6:00 / PM 14:00).{" "}
        <strong>Marcaje correcto</strong>: olvidos = turnos sin par entrada/salida (los marcajes duplicados &lt;10 min no cuentan); ajustes = marcajes forzados por un supervisor. Nota sugerida 1-5; tomala como referencia y ajustá si hay justificación.{" "}
        <strong>Avance</strong> = % de turnos finalizados sobre los esperados del corte (4 Productos / 6 MBK); ej. 2 de 4 = 50%. Llega a 100% al cumplir el mínimo para calificar. Navegá con ‹ › a la <strong>semana en curso</strong> para verlo subir día a día.
      </p>
    </div>
  );
}

// =====================================================================
// HORARIO (solo lectura): quién marcó, por turno AM/PM y área
// =====================================================================
function addDaysISO(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function fmtDM(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
}

const SCHEDULE_ROW_STYLES: Record<string, { label: string; chip: string }> = {
  PROD_AM: { label: "text-amber-700", chip: "bg-amber-100 text-amber-900 border-amber-200" },
  PROD_PM: { label: "text-blue-700", chip: "bg-blue-100 text-blue-900 border-blue-200" },
  MBK_AM: { label: "text-orange-700", chip: "bg-orange-100 text-orange-900 border-orange-200" },
  MBK_PM: { label: "text-sky-700", chip: "bg-sky-100 text-sky-900 border-sky-200" },
  INT_AM: { label: "text-teal-700", chip: "bg-teal-100 text-teal-900 border-teal-200" },
  INT_PM: { label: "text-emerald-700", chip: "bg-emerald-100 text-emerald-900 border-emerald-200" },
  TERC_AM: { label: "text-purple-700", chip: "bg-purple-100 text-purple-900 border-purple-200" },
  TERC_PM: { label: "text-fuchsia-700", chip: "bg-fuchsia-100 text-fuchsia-900 border-fuchsia-200" },
};

function WeeklySchedulePanel() {
  const scheduleFn = useServerFn(getWeeklySchedule);
  const storesFn = useServerFn(listStores);
  const { data: stores, isLoading: storesLoading } = useQuery({ queryKey: ["stores"], queryFn: () => storesFn() });
  const storeList = stores ?? [];
  const [storeId, setStoreId] = useState<string>("");
  const [weekStart, setWeekStart] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!storeId && storeList.length > 0) setStoreId(storeList[0].id);
  }, [storeList, storeId]);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["schedule", storeId, weekStart ?? "current"],
    queryFn: () => scheduleFn({ data: { storeId, ...(weekStart ? { weekStart } : {}) } }),
    enabled: !!storeId,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-foreground">Horario — quién marcó</h2>
          <p className="text-sm text-muted-foreground">
            Se llena solo con los marcajes reales (entrada), por turno AM/PM y área.
          </p>
        </div>
        <Select value={storeId} onValueChange={setStoreId}>
          <SelectTrigger className="w-60"><SelectValue placeholder="Selecciona tienda…" /></SelectTrigger>
          <SelectContent>
            {storeList.map((s) => (
              <SelectItem key={s.id} value={s.id}>{s.code} · {s.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="outline" size="sm" disabled={!data} onClick={() => data && setWeekStart(addDaysISO(data.weekStart, -7))}>
          ← Semana anterior
        </Button>
        <div className="text-sm text-muted-foreground">
          {data ? `Semana del ${fmtDM(data.weekStart)} al ${fmtDM(data.weekEnd)}` : "…"}
          {isFetching ? " · actualizando" : ""}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setWeekStart(undefined)}>Esta semana</Button>
          <Button variant="outline" size="sm" disabled={!data} onClick={() => data && setWeekStart(addDaysISO(data.weekStart, 7))}>
            Semana siguiente →
          </Button>
        </div>
      </div>

      <div className="bg-card rounded-2xl border border-border overflow-x-auto">
        {isLoading || !data ? (
          <div className="text-center py-12 text-muted-foreground">
            {storeId ? "Cargando horario…" : storesLoading ? "Cargando…" : "No hay tiendas disponibles."}
          </div>
        ) : (
          <table className="w-full border-collapse text-sm min-w-[860px]">
            <thead>
              <tr className="bg-secondary/50">
                <th className="text-left p-3 font-semibold text-foreground w-48">Turno</th>
                {data.days.map((d) => (
                  <th key={d.date} className="text-left p-3 font-semibold text-foreground">
                    <div>{d.label}</div>
                    <div className="text-xs font-normal text-muted-foreground">{d.dayNum}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => {
                const st = SCHEDULE_ROW_STYLES[row.key] ?? { label: "", chip: "bg-secondary border-border" };
                return (
                  <tr key={row.key} className="border-t border-border align-top">
                    <td className={`p-3 font-semibold ${st.label}`}>{row.label}</td>
                    {row.cells.map((cell) => (
                      <td key={cell.date} className="p-2 align-top">
                        {cell.people.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <div className="flex flex-col gap-1">
                            {cell.people.map((p) => (
                              <span key={p.id} className={`text-xs rounded-md border px-2 py-1 ${st.chip}`}>{p.name}</span>
                            ))}
                          </div>
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        El turno AM/PM se calcula por la hora de <strong>entrada</strong> (hora de Nicaragua). Área: Agente MBK → MBK; los demás roles → Productos.
        Este horario es de solo lectura (refleja marcajes reales), no es planificación.
      </p>
    </div>
  );
}

function DashboardPanel() {
  const metricsFn = useServerFn(getDashboardMetrics);
  const summaryFn = useServerFn(getEmployeeSummary);
  const exportFn = useServerFn(exportAttendance);
  const filter = useStoreFilter();
  const [days, setDays] = useState(7);
  const [exporting, setExporting] = useState(false);
  const [openEmployee, setOpenEmployee] = useState<{ id: string; name: string } | null>(null);

  const doExport = async () => {
    setExporting(true);
    try {
      const exportArgs: { days: number; storeId?: string; zoneId?: string } = { days };
      if (filter.storeId !== "all") exportArgs.storeId = filter.storeId;
      else if (filter.zoneId !== "all") exportArgs.zoneId = filter.zoneId;
      const rows = await exportFn({ data: exportArgs });
      const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      const header = ["Fecha", "Hora", "Codigo", "Nombre", "Rol", "Tienda", "Tipo", "UbicacionValida"];
      const lines = [header.join(",")].concat(
        rows.map((r) => [r.fecha, r.hora, r.codigo, esc(r.nombre), r.rol, esc(r.tienda), r.tipo, r.ubicacion_valida].join(",")),
      );
      const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `marcajes_${days}d.csv`;
      a.click();
      URL.revokeObjectURL(url);
      if (rows.length === 0) toast.message("No hay marcajes en el periodo seleccionado.");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error al exportar");
    } finally {
      setExporting(false);
    }
  };

  const metricArgs: { days: number; storeId?: string; zoneId?: string } = { days };
  if (filter.storeId !== "all") metricArgs.storeId = filter.storeId;
  else if (filter.zoneId !== "all") metricArgs.zoneId = filter.zoneId;
  const { data: m, isLoading } = useQuery({
    queryKey: ["dashboard", days, filter.zoneId, filter.storeId],
    queryFn: () => metricsFn({ data: metricArgs }),
    refetchInterval: 20_000,
  });
  const { data: summary } = useQuery({
    queryKey: ["empSummary", days],
    queryFn: () => summaryFn({ data: { days } }),
  });
  const summaryRows = (summary ?? []).filter((e) => filter.matches(e.store_id));

  if (isLoading || !m) {
    return <div className="text-center py-12 text-muted-foreground">Cargando dashboard…</div>;
  }

  const isSuper = m.scope.isAdmin || m.scope.isOperations;
  const isZone = m.scope.isZoneAdmin && !isSuper;
  const isStore = !isSuper && !isZone;
  const levelTitle = isSuper
    ? "Resumen ejecutivo · General"
    : isZone ? "Resumen ejecutivo · Mi zona" : "Resumen ejecutivo · Mi tienda";

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-foreground">{levelTitle}</h2>
          <p className="text-sm text-muted-foreground">
            Hoy · histórico {days} días · se actualiza cada 20 s
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {filter.bar}
          <Button variant="outline" size="sm" onClick={doExport} disabled={exporting} title="Descargar los marcajes del periodo (Excel/CSV)">
            <Download className="h-4 w-4 mr-1" /> {exporting ? "Generando…" : "Descargar"}
          </Button>
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Hoy</SelectItem>
              <SelectItem value="7">7 días</SelectItem>
              <SelectItem value="30">30 días</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {isStore ? (
          <>
            <KPI label="Dotación hoy" value={`${m.dotacion_today.real}/${m.dotacion_today.plan}`} sub={`${m.dotacion_today.pct}% cubierto`} accent="entry" />
            <KPI label="Presentes hoy" value={m.present_today} sub={`${m.attendance_pct}% del total`} accent="muted" />
            <KPI label="Dentro ahora" value={m.inside_now} accent="primary" />
            <KPI label="Entradas hoy" value={m.today_entries} accent="exit" />
          </>
        ) : (
          <>
            <KPI label={isSuper ? "Tiendas" : "Tiendas (mi zona)"} value={m.stores_count} accent="primary" />
            <KPI label="Dotación hoy" value={`${m.dotacion_today.real}/${m.dotacion_today.plan}`} sub={`${m.dotacion_today.pct}% cubierto`} accent="entry" />
            <KPI label="Presentes hoy" value={m.present_today} sub={`${m.attendance_pct}% del total`} accent="muted" />
            <KPI label="Dentro ahora" value={m.inside_now} accent="exit" />
          </>
        )}
      </div>

      <DotacionStoreTable rows={m.by_store} />

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

      {isStore && (
        <div className="grid lg:grid-cols-2 gap-4">
          <div className="bg-card rounded-2xl border border-border overflow-hidden">
            <div className="p-4 border-b border-border">
              <h3 className="font-semibold text-foreground">Dotación cubierta hoy</h3>
              <p className="text-xs text-muted-foreground">Agentes presentes vs plan del día</p>
            </div>
            <div className="flex items-end gap-3 px-4 pt-4">
              <div className="text-5xl font-extrabold text-[oklch(0.6_0.16_155)] leading-none">{m.dotacion_today.pct}%</div>
              <div className="text-sm text-muted-foreground pb-1">{m.dotacion_today.real} de {m.dotacion_today.plan} de la dotación · {m.inside_now} dentro</div>
            </div>
            <RoleTable rows={m.by_role} />
          </div>
          <InsideCard inside={m.inside} />
        </div>
      )}

      {isStore && (
        <div className="bg-card rounded-2xl border border-border overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-2">
            <h3 className="font-semibold text-foreground">No han marcado hoy</h3>
            <Badge variant="outline" className="border-amber-500 text-amber-700">{m.absent_today.length}</Badge>
          </div>
          {m.absent_today.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">Todos marcaron entrada. 🎉</p>
          ) : (
            <div className="p-4 flex flex-wrap gap-2">
              {m.absent_today.map((a) => (
                <span key={a.id} className="text-xs rounded-md border border-amber-200 bg-amber-50 text-amber-800 px-2 py-1">
                  {a.full_name} <span className="font-mono opacity-70">{a.employee_code}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {isZone && (
        <div className="grid lg:grid-cols-2 gap-4">
          <StoreExecTable title="Por tienda (mi zona)" subtitle="Presentes / colaboradores y actividad" rows={m.by_store} />
          <div className="bg-card rounded-2xl border border-border overflow-hidden">
            <div className="p-4 border-b border-border">
              <h3 className="font-semibold text-foreground">Por tipo de colaborador</h3>
              <p className="text-xs text-muted-foreground">Presentes hoy / total</p>
            </div>
            <RoleTable rows={m.by_role} />
          </div>
        </div>
      )}

      {isSuper && (
        <>
          <ZoneExecTable rows={m.by_zone} />
          <div className="grid lg:grid-cols-2 gap-4">
            <StoreExecTable title="Por tienda (ranking)" subtitle="Top 15 por actividad" rows={m.by_store.slice(0, 15)} />
            <div className="bg-card rounded-2xl border border-border overflow-hidden">
              <div className="p-4 border-b border-border">
                <h3 className="font-semibold text-foreground">Por tipo de colaborador</h3>
                <p className="text-xs text-muted-foreground">Presentes hoy / total</p>
              </div>
              <RoleTable rows={m.by_role} />
            </div>
          </div>
        </>
      )}

      <div className="bg-card rounded-2xl border border-border overflow-hidden">
        <div className="p-4 border-b border-border">
          <h3 className="font-semibold text-foreground">Asistencia por colaborador</h3>
          <p className="text-xs text-muted-foreground">Detalle del periodo · clic en una fila para ver la semana</p>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="bg-secondary/50">
              <TableHead>Colaborador</TableHead>
              <TableHead>Rol</TableHead>
              <TableHead className="text-right">Días</TableHead>
              <TableHead className="text-right">Horas</TableHead>
              <TableHead className="text-right">Marcajes</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summaryRows.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="text-center py-6 text-muted-foreground">Sin datos en el periodo.</TableCell></TableRow>
            ) : summaryRows.map((e) => (
              <TableRow key={e.id} className="cursor-pointer hover:bg-secondary/40" onClick={() => setOpenEmployee({ id: e.id, name: e.full_name })}>
                <TableCell>
                  <div className="font-medium text-foreground">{e.full_name}</div>
                  <div className="text-xs text-muted-foreground font-mono">{e.employee_code}</div>
                </TableCell>
                <TableCell className="text-muted-foreground">{ROLE_LABELS[e.role as EmployeeRole] ?? e.role}</TableCell>
                <TableCell className="text-right">{e.days_present}</TableCell>
                <TableCell className="text-right font-medium">{e.hours}</TableCell>
                <TableCell className="text-right text-muted-foreground">{e.marks}</TableCell>
                <TableCell className="text-right"><ChevronRight className="h-4 w-4 text-muted-foreground inline" /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {openEmployee && (
        <EmployeeWeeklyModal
          employeeId={openEmployee.id}
          employeeName={openEmployee.name}
          onClose={() => setOpenEmployee(null)}
        />
      )}
    </div>
  );
}

function KPI({ label, value, accent, sub }: { label: string; value: number | string; accent: "entry" | "exit" | "primary" | "muted"; sub?: string }) {
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
      {sub && <div className="text-[11px] mt-0.5 opacity-80">{sub}</div>}
    </div>
  );
}

function InsideCard({ inside }: { inside: Array<{ id: string; full_name: string; employee_code: string; since: string }> }) {
  return (
    <div className="bg-card rounded-2xl border border-border overflow-hidden">
      <div className="p-4 border-b border-border">
        <h3 className="font-semibold text-foreground">Dentro ahora</h3>
        <p className="text-xs text-muted-foreground">Entrada sin salida registrada hoy</p>
      </div>
      <Table>
        <TableHeader><TableRow className="bg-secondary/50"><TableHead>Colaborador</TableHead><TableHead className="text-right">Desde</TableHead></TableRow></TableHeader>
        <TableBody>
          {inside.length === 0 ? (
            <TableRow><TableCell colSpan={2} className="text-center py-6 text-muted-foreground">Nadie adentro.</TableCell></TableRow>
          ) : inside.map((i) => (
            <TableRow key={i.id}>
              <TableCell><div className="font-medium text-foreground">{i.full_name}</div><div className="text-xs text-muted-foreground font-mono">{i.employee_code}</div></TableCell>
              <TableCell className="text-right text-sm text-muted-foreground">{new Date(i.since).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function RoleTable({ rows }: { rows: Array<{ role: string; employees: number; present: number }> }) {
  return (
    <Table>
      <TableHeader><TableRow className="bg-secondary/50"><TableHead>Tipo</TableHead><TableHead className="text-right">Presentes</TableHead><TableHead className="text-right">Total</TableHead></TableRow></TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow><TableCell colSpan={3} className="text-center py-6 text-muted-foreground">Sin colaboradores.</TableCell></TableRow>
        ) : rows.map((r) => (
          <TableRow key={r.role}>
            <TableCell className="text-foreground">{ROLE_LABELS[r.role as EmployeeRole] ?? r.role}</TableCell>
            <TableCell className="text-right font-medium">{r.present}</TableCell>
            <TableCell className="text-right text-muted-foreground">{r.employees}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function StoreExecTable({ title, subtitle, rows }: {
  title: string; subtitle: string;
  rows: Array<{ id: string; code: string; name: string; employees: number; present_today: number; inside_now: number; today_entries: number; period_total: number }>;
}) {
  return (
    <div className="bg-card rounded-2xl border border-border overflow-hidden">
      <div className="p-4 border-b border-border">
        <h3 className="font-semibold text-foreground">{title}</h3>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow className="bg-secondary/50">
            <TableHead>Tienda</TableHead>
            <TableHead className="text-right">Presentes</TableHead>
            <TableHead className="text-right">Dentro</TableHead>
            <TableHead className="text-right">Entradas hoy</TableHead>
            <TableHead className="text-right">Total</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow><TableCell colSpan={5} className="text-center py-6 text-muted-foreground">Sin tiendas.</TableCell></TableRow>
            ) : rows.map((s) => (
              <TableRow key={s.id}>
                <TableCell><span className="font-mono text-foreground">{s.code}</span> <span className="text-muted-foreground">· {s.name}</span></TableCell>
                <TableCell className="text-right text-sm">{s.present_today}/{s.employees}</TableCell>
                <TableCell className="text-right text-sm">{s.inside_now}</TableCell>
                <TableCell className="text-right text-sm">{s.today_entries}</TableCell>
                <TableCell className="text-right text-sm font-medium">{s.period_total}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function DotacionStoreTable({ rows }: {
  rows: Array<{ id: string; code: string; name: string; dot_day_real: number; dot_day_plan: number; dot_week_real: number; dot_week_plan: number }>;
}) {
  const [view, setView] = useState<"day" | "week">("day");
  return (
    <div className="bg-card rounded-2xl border border-border overflow-hidden">
      <div className="p-4 border-b border-border flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <h3 className="font-semibold text-foreground">Dotación real por tienda</h3>
          <p className="text-xs text-muted-foreground">Agentes presentes (Productos + MBK) vs plan</p>
        </div>
        <Tabs value={view} onValueChange={(v) => setView(v as "day" | "week")}>
          <TabsList className="bg-secondary border border-border">
            <TabsTrigger value="day" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">Diaria</TabsTrigger>
            <TabsTrigger value="week" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">Semanal</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow className="bg-secondary/50">
            <TableHead>Tienda</TableHead>
            <TableHead className="text-right">Real</TableHead>
            <TableHead className="text-right">Plan</TableHead>
            <TableHead className="text-right">Cumplimiento</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow><TableCell colSpan={4} className="text-center py-6 text-muted-foreground">Sin tiendas.</TableCell></TableRow>
            ) : rows.map((s) => {
              const real = view === "day" ? s.dot_day_real : s.dot_week_real;
              const plan = view === "day" ? s.dot_day_plan : s.dot_week_plan;
              const pct = plan > 0 ? Math.round((real / plan) * 100) : 0;
              return (
                <TableRow key={s.id}>
                  <TableCell><span className="font-mono text-foreground">{s.code}</span> <span className="text-muted-foreground">· {s.name}</span></TableCell>
                  <TableCell className="text-right text-sm font-medium">{real}</TableCell>
                  <TableCell className="text-right text-sm text-muted-foreground">{plan}</TableCell>
                  <TableCell className={`text-right text-sm font-semibold ${pct >= 100 ? "text-[oklch(0.55_0.14_155)]" : "text-amber-700"}`}>{plan ? pct + "%" : "—"}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="px-4 py-2 text-[11px] text-muted-foreground border-t border-border">
        {view === "day"
          ? "Hoy: agentes distintos que marcaron entrada vs el plan del día."
          : "Últimos 7 días: suma de agentes presentes por día vs la suma del plan diario."}
      </p>
    </div>
  );
}

function ZoneExecTable({ rows }: {
  rows: Array<{ zone_id: string; code: string; name: string; stores: number; employees: number; present_today: number; inside_now: number; today_entries: number; period_total: number }>;
}) {
  return (
    <div className="bg-card rounded-2xl border border-border overflow-hidden">
      <div className="p-4 border-b border-border">
        <h3 className="font-semibold text-foreground">Por zona</h3>
        <p className="text-xs text-muted-foreground">Resumen de cada zona</p>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow className="bg-secondary/50">
            <TableHead>Zona</TableHead>
            <TableHead className="text-right">Tiendas</TableHead>
            <TableHead className="text-right">Colab.</TableHead>
            <TableHead className="text-right">Presentes</TableHead>
            <TableHead className="text-right">Dentro</TableHead>
            <TableHead className="text-right">Entradas hoy</TableHead>
            <TableHead className="text-right">Total</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="text-center py-6 text-muted-foreground">Sin zonas.</TableCell></TableRow>
            ) : rows.map((z) => (
              <TableRow key={z.zone_id}>
                <TableCell><span className="font-mono text-foreground">{z.code}</span> <span className="text-muted-foreground">· {z.name}</span></TableCell>
                <TableCell className="text-right text-sm">{z.stores}</TableCell>
                <TableCell className="text-right text-sm">{z.employees}</TableCell>
                <TableCell className="text-right text-sm font-medium">{z.present_today}</TableCell>
                <TableCell className="text-right text-sm">{z.inside_now}</TableCell>
                <TableCell className="text-right text-sm">{z.today_entries}</TableCell>
                <TableCell className="text-right text-sm">{z.period_total}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// =====================================================================
// TIENDAS — panel limitado del Gerente de Zona (solo PIN terminal + contraseña GT)
// =====================================================================
function ZoneStoresPanel() {
  const storesFn = useServerFn(listStores);
  const setPinFn = useServerFn(setStoreTerminalPin);
  const resetPwFn = useServerFn(resetManagerPassword);
  const { data, isLoading } = useQuery({ queryKey: ["stores"], queryFn: () => storesFn() });
  const stores = data ?? [];
  const [pinStore, setPinStore] = useState<{ id: string; label: string } | null>(null);
  const [pinValue, setPinValue] = useState("");

  const savePin = async () => {
    if (!pinStore) return;
    if (!/^\d{4,8}$/.test(pinValue)) { toast.error("PIN de 4-8 dígitos"); return; }
    try {
      await setPinFn({ data: { storeId: pinStore.id, terminal_pin: pinValue } });
      toast.success("PIN de terminal actualizado");
      setPinStore(null);
      setPinValue("");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  };

  const resetPw = async (id: string, label: string) => {
    if (!confirm(`¿Restablecer la contraseña de acceso del Gerente de Tienda de ${label}?`)) return;
    try {
      const r = await resetPwFn({ data: { storeId: id } });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success("Contraseña restablecida");
      window.prompt(`Contraseña temporal para ${r.emails.join(", ")} (cópiala y entrégala al GT):`, r.password);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-foreground">Tiendas de mi zona</h2>
        <p className="text-sm text-muted-foreground">
          Puedes cambiar el <strong>PIN de terminal</strong> y restablecer la <strong>contraseña del Gerente de Tienda</strong>. El resto de la configuración la gestiona un Super administrador.
        </p>
      </div>
      <div className="bg-card rounded-2xl border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-secondary/50">
              <TableHead>Tienda</TableHead>
              <TableHead className="text-right">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={2} className="text-center py-8 text-muted-foreground">Cargando…</TableCell></TableRow>
            ) : stores.length === 0 ? (
              <TableRow><TableCell colSpan={2} className="text-center py-8 text-muted-foreground">No tienes tiendas asignadas.</TableCell></TableRow>
            ) : stores.map((s) => (
              <TableRow key={s.id}>
                <TableCell><span className="font-mono text-foreground">{s.code}</span> <span className="text-muted-foreground">· {s.name}</span></TableCell>
                <TableCell className="text-right space-x-1 whitespace-nowrap">
                  <Button variant="outline" size="sm" onClick={() => { setPinStore({ id: s.id, label: `${s.code} · ${s.name}` }); setPinValue(""); }}>
                    <KeyRound className="h-4 w-4 mr-1 text-amber-600" /> PIN terminal
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => resetPw(s.id, `${s.code} · ${s.name}`)}>
                    <ShieldCheck className="h-4 w-4 mr-1" /> Contraseña GT
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={!!pinStore} onOpenChange={(o) => { if (!o) { setPinStore(null); setPinValue(""); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>PIN de terminal — {pinStore?.label}</DialogTitle></DialogHeader>
          <div>
            <Label>Nuevo PIN de terminal (4-8 dígitos)</Label>
            <Input
              type="text"
              inputMode="numeric"
              maxLength={8}
              value={pinValue}
              onChange={(e) => setPinValue(e.target.value.replace(/\D/g, ""))}
              placeholder="Ej. 2580"
              autoFocus
            />
            <p className="text-xs text-muted-foreground mt-1">Con este código se vincula la tablet de la tienda al marcaje.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPinStore(null)}>Cancelar</Button>
            <Button onClick={savePin} className="bg-accent text-accent-foreground hover:bg-accent/90">Guardar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
  const resetPwFn = useServerFn(resetManagerPassword);
  const zonesFn = useServerFn(listZones);
  const qc = useQueryClient();

  const resetPwStore = async (id: string, label: string) => {
    if (!confirm(`¿Restablecer la contraseña de acceso del Gerente de Tienda de ${label}?`)) return;
    try {
      const r = await resetPwFn({ data: { storeId: id } });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success("Contraseña restablecida");
      window.prompt(`Contraseña temporal para ${r.emails.join(", ")} (cópiala y entrégala al GT):`, r.password);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  };

  const { data, isLoading } = useQuery({ queryKey: ["stores"], queryFn: () => listFn() });
  const { data: zones } = useQuery({ queryKey: ["zones"], queryFn: () => zonesFn() });
  const stores = data ?? [];
  const zoneList = zones ?? [];

  const [open, setOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [editing, setEditing] = useState<(typeof stores)[number] | null>(null);
  const [form, setForm] = useState({ code: "", name: "", address: "", terminal_pin: "", active: true, zone_id: "" as string });
  const [geoForm, setGeoForm] = useState({ latitude: "", longitude: "", radius: "300" });

  useEffect(() => {
    if (editing) {
      const e = editing as { zone_id?: string | null };
      setForm({
        code: editing.code,
        name: editing.name,
        address: editing.address ?? "",
        terminal_pin: "",
        active: editing.active,
        zone_id: e.zone_id ?? "",
      });
      const g = editing as { latitude?: number | null; longitude?: number | null; geofence_radius_m?: number | null };
      setGeoForm({
        latitude: g.latitude != null ? String(g.latitude) : "",
        longitude: g.longitude != null ? String(g.longitude) : "",
        radius: g.geofence_radius_m != null ? String(g.geofence_radius_m) : "300",
      });
    } else {
      setForm({ code: "", name: "", address: "", terminal_pin: "", active: true, zone_id: "" });
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
            zone_id: form.zone_id || null,
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
            zone_id: form.zone_id || null,
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
                <div>
                  <Label>Zona</Label>
                  <Select value={form.zone_id || "__none__"} onValueChange={(v) => setForm({ ...form, zone_id: v === "__none__" ? "" : v })}>
                    <SelectTrigger><SelectValue placeholder="Sin zona" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Sin zona</SelectItem>
                      {zoneList.map((z) => (
                        <SelectItem key={z.id} value={z.id}>{z.code} · {z.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
              <TableHead>Zona</TableHead>
              <TableHead>Dirección</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead className="text-right">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Cargando…</TableCell></TableRow>
            ) : stores.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                Sin tiendas. Usa "Carga masiva" para crear A01–A95 de un solo paso.
              </TableCell></TableRow>
            ) : stores.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-mono text-foreground">{s.code}</TableCell>
                <TableCell className="font-medium text-foreground">{s.name}</TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {(() => {
                    const z = (s as { zones?: { code?: string; name?: string } | { code?: string; name?: string }[] }).zones;
                    const zone = Array.isArray(z) ? z[0] : z;
                    return zone?.code ? `${zone.code} · ${zone.name ?? ""}` : "—";
                  })()}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">{s.address ?? "—"}</TableCell>
                <TableCell>
                  {s.active ? (
                    <Badge className="bg-[oklch(0.65_0.16_155)] text-white hover:bg-[oklch(0.65_0.16_155)]">Activa</Badge>
                  ) : (
                    <Badge variant="secondary">Inactiva</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" title="Restablecer contraseña del Gerente de Tienda" onClick={() => resetPwStore(s.id, `${s.code} · ${s.name}`)}>
                    <ShieldCheck className="h-4 w-4 text-primary" />
                  </Button>
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

// =====================================================================
// ZONAS
// =====================================================================
function ZonesPanel() {
  const listFn = useServerFn(listZones);
  const createFn = useServerFn(createZone);
  const updateFn = useServerFn(updateZone);
  const deleteFn = useServerFn(deleteZone);
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["zones"], queryFn: () => listFn() });
  const zones = data ?? [];
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<(typeof zones)[number] | null>(null);
  const [form, setForm] = useState({ code: "", name: "", active: true });

  useEffect(() => {
    if (editing) setForm({ code: editing.code, name: editing.name, active: editing.active });
    else setForm({ code: "", name: "", active: true });
  }, [editing, open]);

  const save = async () => {
    try {
      if (editing) {
        await updateFn({ data: { id: editing.id, name: form.name, active: form.active } });
        toast.success("Zona actualizada");
      } else {
        await createFn({ data: { code: form.code, name: form.name, active: form.active } });
        toast.success("Zona creada");
      }
      setOpen(false); setEditing(null);
      qc.invalidateQueries({ queryKey: ["zones"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error al guardar");
    }
  };

  const remove = async (id: string) => {
    if (!confirm("¿Eliminar esta zona? Las tiendas quedarán sin zona asignada.")) return;
    try {
      await deleteFn({ data: { id } });
      toast.success("Zona eliminada");
      qc.invalidateQueries({ queryKey: ["zones"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error al eliminar");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-foreground">Zonas</h2>
          <p className="text-sm text-muted-foreground">{zones.length} registradas</p>
        </div>
        <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setEditing(null); }}>
          <DialogTrigger asChild>
            <Button className="bg-accent text-accent-foreground hover:bg-accent/90">
              <Plus className="h-4 w-4 mr-2" /> Nueva zona
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>{editing ? "Editar zona" : "Nueva zona"}</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>Código</Label>
                <Input disabled={!!editing} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="Ej. NORTE, SUR, METRO" />
              </div>
              <div>
                <Label>Nombre</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ej. Zona Norte" />
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
      <div className="bg-card rounded-2xl border border-border overflow-hidden">
        <Table>
          <TableHeader><TableRow className="bg-secondary/50">
            <TableHead>Código</TableHead><TableHead>Nombre</TableHead><TableHead>Estado</TableHead><TableHead className="text-right">Acciones</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Cargando…</TableCell></TableRow>
            ) : zones.length === 0 ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Crea la primera zona para agrupar tus tiendas.</TableCell></TableRow>
            ) : zones.map((z) => (
              <TableRow key={z.id}>
                <TableCell className="font-mono text-foreground">{z.code}</TableCell>
                <TableCell className="font-medium text-foreground">{z.name}</TableCell>
                <TableCell>{z.active ? <Badge className="bg-[oklch(0.65_0.16_155)] text-white">Activa</Badge> : <Badge variant="secondary">Inactiva</Badge>}</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => { setEditing(z); setOpen(true); }}><Pencil className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="sm" onClick={() => remove(z.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
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
// USUARIOS ADMIN
// =====================================================================
function AdminUsersPanel({ isAdmin }: { isAdmin: boolean }) {
  const listFn = useServerFn(listAdminUsers);
  const upsertFn = useServerFn(upsertAdminUser);
  const removeFn = useServerFn(removeAdminRole);
  const setZonesFn = useServerFn(setUserZones);
  const setStoresFn = useServerFn(setUserStores);
  const seedFn = useServerFn(seedZoneManagers);
  const seedGoFn = useServerFn(seedOperationsManager);
  const seedGtFn = useServerFn(seedStoreManagers);
  const seedExtraFn = useServerFn(seedExtraSuperAdmins);
  const zonesFn = useServerFn(listZones);
  const storesFn = useServerFn(listStores);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({ queryKey: ["adminUsers"], queryFn: () => listFn() });
  const { data: zones } = useQuery({ queryKey: ["zones"], queryFn: () => zonesFn() });
  const { data: stores } = useQuery({ queryKey: ["stores"], queryFn: () => storesFn() });
  const users = data ?? [];

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    email: "", password: "", role: "gerente_tienda" as "admin" | "gerente_operaciones" | "gerente_tienda" | "gerente_zona",
    zone_ids: [] as string[], store_ids: [] as string[],
  });
  const [editing, setEditing] = useState<(typeof users)[number] | null>(null);
  const [editZones, setEditZones] = useState<Set<string>>(new Set());
  const [editStores, setEditStores] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (editing) {
      setEditZones(new Set(editing.zones.map((z) => z.id)));
      setEditStores(new Set(editing.stores.map((s) => s.id)));
    }
  }, [editing]);

  const save = async () => {
    try {
      const r = await upsertFn({ data: {
        email: form.email,
        password: form.password || undefined,
        role: form.role,
        zone_ids: form.role === "gerente_zona" ? form.zone_ids : undefined,
        store_ids: form.role === "gerente_tienda" ? form.store_ids : undefined,
      }});
      if (!r.ok) { toast.error(r.error); return; }
      toast.success("Usuario admin creado/actualizado");
      setOpen(false);
      setForm({ email: "", password: "", role: "gerente_tienda", zone_ids: [], store_ids: [] });
      qc.invalidateQueries({ queryKey: ["adminUsers"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      if (editing.roles.includes("gerente_zona"))
        await setZonesFn({ data: { user_id: editing.user_id, zone_ids: Array.from(editZones) } });
      if (editing.roles.includes("gerente_tienda"))
        await setStoresFn({ data: { user_id: editing.user_id, store_ids: Array.from(editStores) } });
      toast.success("Asignaciones actualizadas");
      setEditing(null);
      qc.invalidateQueries({ queryKey: ["adminUsers"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  };

  const removeRole = async (user_id: string, role: string) => {
    if (!confirm(`¿Quitar rol "${ADMIN_ROLE_LABELS[role] ?? role}" a este usuario?`)) return;
    try {
      await removeFn({ data: { user_id, role: role as "admin" | "gerente_operaciones" | "gerente_tienda" | "gerente_zona" } });
      toast.success("Rol removido");
      qc.invalidateQueries({ queryKey: ["adminUsers"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-foreground">Usuarios administrativos</h2>
          <p className="text-sm text-muted-foreground">Gestiona quién puede acceder al panel y qué tiendas/zonas ve</p>
        </div>
        <div className="flex gap-2">
          <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="bg-accent text-accent-foreground hover:bg-accent/90">
              <Plus className="h-4 w-4 mr-2" /> Nuevo usuario admin
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Nuevo usuario administrativo</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>Email</Label>
                <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="usuario@empresa.com" />
              </div>
              <div>
                <Label>Contraseña inicial (sólo si el usuario no existe)</Label>
                <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="mínimo 8 caracteres" />
              </div>
              <div>
                <Label>Rol</Label>
                <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v as typeof form.role })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="gerente_tienda">Gerente de Tienda</SelectItem>
                    <SelectItem value="gerente_zona">Gerente de Zona (Admin)</SelectItem>
                    {isAdmin && <SelectItem value="gerente_operaciones">Gerente de Operaciones</SelectItem>}
                    {isAdmin && <SelectItem value="admin">Administrador</SelectItem>}
                  </SelectContent>
                </Select>
              </div>
              {form.role === "gerente_tienda" && (
                <div className="rounded-xl border border-border p-2 bg-secondary/40 max-h-48 overflow-y-auto space-y-1">
                  <p className="text-xs text-muted-foreground px-1">Tiendas asignadas</p>
                  {(stores ?? []).map((s) => (
                    <label key={s.id} className="flex items-center gap-2 text-sm py-1 px-1">
                      <input type="checkbox" checked={form.store_ids.includes(s.id)} onChange={(e) => {
                        setForm({ ...form, store_ids: e.target.checked ? [...form.store_ids, s.id] : form.store_ids.filter((x) => x !== s.id) });
                      }} />
                      <span className="font-mono text-xs">{s.code}</span><span>{s.name}</span>
                    </label>
                  ))}
                </div>
              )}
              {form.role === "gerente_zona" && (
                <div className="rounded-xl border border-border p-2 bg-secondary/40 max-h-48 overflow-y-auto space-y-1">
                  <p className="text-xs text-muted-foreground px-1">Zonas asignadas</p>
                  {(zones ?? []).map((z) => (
                    <label key={z.id} className="flex items-center gap-2 text-sm py-1 px-1">
                      <input type="checkbox" checked={form.zone_ids.includes(z.id)} onChange={(e) => {
                        setForm({ ...form, zone_ids: e.target.checked ? [...form.zone_ids, z.id] : form.zone_ids.filter((x) => x !== z.id) });
                      }} />
                      <span className="font-mono text-xs">{z.code}</span><span>{z.name}</span>
                    </label>
                  ))}
                </div>
              )}
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
          <TableHeader><TableRow className="bg-secondary/50">
            <TableHead>Email</TableHead><TableHead>Roles</TableHead><TableHead>Alcance</TableHead><TableHead className="text-right">Acciones</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Cargando…</TableCell></TableRow>
            ) : users.length === 0 ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Sin usuarios administrativos.</TableCell></TableRow>
            ) : users.map((u) => (
              <TableRow key={u.user_id}>
                <TableCell className="font-medium text-foreground">{u.email ?? <span className="text-muted-foreground italic">sin email</span>}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {u.roles.map((r) => (
                      <Badge key={r} variant="secondary" className="text-xs">
                        {ADMIN_ROLE_LABELS[r] ?? r}
                        {(isAdmin || (r !== "admin" && r !== "gerente_operaciones")) && (
                          <button className="ml-1 hover:text-destructive" onClick={() => removeRole(u.user_id, r)}>×</button>
                        )}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {u.zones.length > 0 && <div>Zonas: {u.zones.map((z) => z.code).join(", ")}</div>}
                  {u.stores.length > 0 && <div>Tiendas: {u.stores.map((s) => s.code).join(", ")}</div>}
                  {u.roles.includes("admin") || u.roles.includes("gerente_operaciones") ? <div>Todas las tiendas</div> : null}
                </TableCell>
                <TableCell className="text-right">
                  {(u.roles.includes("gerente_zona") || u.roles.includes("gerente_tienda")) && (
                    <Button variant="ghost" size="sm" onClick={() => setEditing(u)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {editing && (
        <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Editar asignaciones · {editing.email}</DialogTitle></DialogHeader>
            <div className="space-y-3">
              {editing.roles.includes("gerente_zona") && (
                <div>
                  <Label className="text-sm">Zonas asignadas</Label>
                  <div className="rounded-xl border border-border p-2 bg-secondary/40 max-h-48 overflow-y-auto space-y-1 mt-1">
                    {(zones ?? []).map((z) => (
                      <label key={z.id} className="flex items-center gap-2 text-sm py-1 px-1">
                        <input type="checkbox" checked={editZones.has(z.id)} onChange={(e) => {
                          const n = new Set(editZones); if (e.target.checked) n.add(z.id); else n.delete(z.id); setEditZones(n);
                        }} />
                        <span className="font-mono text-xs">{z.code}</span><span>{z.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
              {editing.roles.includes("gerente_tienda") && (
                <div>
                  <Label className="text-sm">Tiendas asignadas</Label>
                  <div className="rounded-xl border border-border p-2 bg-secondary/40 max-h-48 overflow-y-auto space-y-1 mt-1">
                    {(stores ?? []).map((s) => (
                      <label key={s.id} className="flex items-center gap-2 text-sm py-1 px-1">
                        <input type="checkbox" checked={editStores.has(s.id)} onChange={(e) => {
                          const n = new Set(editStores); if (e.target.checked) n.add(s.id); else n.delete(s.id); setEditStores(n);
                        }} />
                        <span className="font-mono text-xs">{s.code}</span><span>{s.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditing(null)}>Cancelar</Button>
              <Button onClick={saveEdit} className="bg-accent text-accent-foreground hover:bg-accent/90">Guardar</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// =====================================================================
// MODAL MARCAJE SEMANAL POR PERSONA
// =====================================================================
function EmployeeWeeklyModal({
  employeeId,
  employeeName,
  onClose,
}: {
  employeeId: string;
  employeeName: string;
  onClose: () => void;
}) {
  const fetchFn = useServerFn(getEmployeeWeeklyMarks);
  const [range, setRange] = useState<"current_week" | "previous_week" | "current_month" | "payroll">("current_week");
  const today = new Date().toISOString().slice(0, 10);
  const fifteenAgo = new Date(); fifteenAgo.setDate(fifteenAgo.getDate() - 14);
  const [from, setFrom] = useState(fifteenAgo.toISOString().slice(0, 10));
  const [to, setTo] = useState(today);

  const { data, isLoading } = useQuery({
    queryKey: ["empWeekly", employeeId, range, range === "payroll" ? from : null, range === "payroll" ? to : null],
    queryFn: () => fetchFn({ data: { employeeId, range, ...(range === "payroll" ? { from, to } : {}) } }),
  });

  const dayName = (iso: string) => {
    const d = new Date(iso + "T00:00:00");
    return ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"][(d.getDay() + 6) % 7];
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><CalendarIcon className="h-5 w-5" /> {employeeName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[180px]">
              <Label className="text-xs">Rango</Label>
              <Select value={range} onValueChange={(v) => setRange(v as typeof range)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="current_week">Semana actual</SelectItem>
                  <SelectItem value="previous_week">Semana anterior</SelectItem>
                  <SelectItem value="current_month">Mes actual</SelectItem>
                  <SelectItem value="payroll">Semana planilla</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {range === "payroll" && (
              <>
                <div><Label className="text-xs">Desde</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
                <div><Label className="text-xs">Hasta</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
              </>
            )}
          </div>

          {isLoading || !data ? (
            <p className="text-center py-8 text-muted-foreground">Cargando…</p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-xl bg-primary text-primary-foreground p-3">
                  <div className="text-2xl font-bold">{data.total_hours}</div>
                  <div className="text-xs opacity-90">Horas totales</div>
                </div>
                <div className="rounded-xl bg-accent text-accent-foreground p-3">
                  <div className="text-2xl font-bold">{data.days_present}</div>
                  <div className="text-xs opacity-90">Días con marcaje</div>
                </div>
                <div className="rounded-xl bg-secondary p-3">
                  <div className="text-2xl font-bold">{data.total_marks}</div>
                  <div className="text-xs text-muted-foreground">Marcajes totales</div>
                </div>
              </div>

              <div className="bg-card rounded-2xl border border-border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-secondary/50">
                      <TableHead>Día</TableHead>
                      <TableHead>Entrada</TableHead>
                      <TableHead>Salida</TableHead>
                      <TableHead className="text-right">Marcajes</TableHead>
                      <TableHead className="text-right">Horas</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.days.map((d) => (
                      <TableRow key={d.date} className={d.marks.length === 0 ? "opacity-50" : ""}>
                        <TableCell>
                          <div className="font-medium text-foreground">{dayName(d.date)}</div>
                          <div className="text-xs text-muted-foreground">{d.date}</div>
                        </TableCell>
                        <TableCell className="text-sm">{d.first_entry ? new Date(d.first_entry).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" }) : "—"}</TableCell>
                        <TableCell className="text-sm">{d.last_exit ? new Date(d.last_exit).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" }) : "—"}</TableCell>
                        <TableCell className="text-right">
                          <span className="text-primary">{d.entries}</span> / <span className="text-accent">{d.exits}</span>
                        </TableCell>
                        <TableCell className="text-right font-medium">{d.hours > 0 ? d.hours : "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
