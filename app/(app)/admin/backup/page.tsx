"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, HardDrive, RefreshCw } from "lucide-react";

interface ListedFile { name: string; mtimeMs: number }

export default function AdminBackupPage() {
  const [files, setFiles] = useState<ListedFile[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchList = async () => {
    try {
      const res = await fetch("/api/admin/backup?list=1", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setFiles(data.files || []);
    } catch {}
  };

  useEffect(() => {
    fetchList();
  }, []);

  const createBackup = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/backup", { method: "POST" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(j.error || "Backup failed");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `backup-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.sql`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      await fetchList();
    } finally {
      setLoading(false);
    }
  };

  const download = async (name: string) => {
    const res = await fetch(`/api/admin/backup?file=${encodeURIComponent(name)}`);
    if (!res.ok) return;
    const blob = await res.blob();
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Database Backups</h1>
          <p className="text-muted-foreground">Create a manual backup and download or retrieve the latest backups from the backup volume.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={fetchList}><RefreshCw className="h-4 w-4 mr-2" />Refresh</Button>
          <Button onClick={createBackup} disabled={loading}><HardDrive className="h-4 w-4 mr-2" />{loading ? "Creating…" : "Create Backup"}</Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Available Backups</CardTitle>
          <CardDescription>From the mounted backup volume (/backup)</CardDescription>
        </CardHeader>
        <CardContent>
          {files.length === 0 ? (
            <p className="text-muted-foreground">No backup files found yet.</p>
          ) : (
            <ul className="divide-y">
              {files.map((f) => (
                <li key={f.name} className="flex items-center justify-between py-2">
                  <div className="truncate pr-2">
                    <p className="font-medium truncate">{f.name}</p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => download(f.name)}>
                    <Download className="h-4 w-4 mr-2" /> Download
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

