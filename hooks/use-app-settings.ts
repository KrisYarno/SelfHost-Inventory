import { useEffect, useState } from 'react';

export type DateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD';
export type TimeFormat = '12h' | '24h';

export interface AppSettings {
  displayMode: 'auto' | 'mobile' | 'tablet' | 'desktop';
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  itemsPerPage: number;
  autoRefresh: boolean;
  refreshInterval: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  displayMode: 'auto',
  dateFormat: 'MM/DD/YYYY',
  timeFormat: '12h',
  itemsPerPage: 20,
  autoRefresh: true,
  refreshInterval: 30,
};

export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    const savedSettings = localStorage.getItem('appSettings');
    if (savedSettings) {
      try {
        const parsed = JSON.parse(savedSettings);
        setSettings({ ...DEFAULT_SETTINGS, ...parsed });
      } catch (error) {
        console.error('Error loading app settings:', error);
      }
    }
  }, []);

  const formatDate = (date: Date | string): string => {
    const d = typeof date === 'string' ? new Date(date) : date;
    const day = d.getDate().toString().padStart(2, '0');
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const year = d.getFullYear();

    switch (settings.dateFormat) {
      case 'DD/MM/YYYY':
        return `${day}/${month}/${year}`;
      case 'YYYY-MM-DD':
        return `${year}-${month}-${day}`;
      case 'MM/DD/YYYY':
      default:
        return `${month}/${day}/${year}`;
    }
  };

  const formatTime = (date: Date | string): string => {
    const d = typeof date === 'string' ? new Date(date) : date;
    const hours = d.getHours();
    const minutes = d.getMinutes().toString().padStart(2, '0');

    if (settings.timeFormat === '24h') {
      return `${hours.toString().padStart(2, '0')}:${minutes}`;
    }

    const period = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
    return `${displayHours}:${minutes} ${period}`;
  };

  const formatDateTime = (date: Date | string): string => {
    return `${formatDate(date)} ${formatTime(date)}`;
  };

  return {
    settings,
    formatDate,
    formatTime,
    formatDateTime,
  };
}