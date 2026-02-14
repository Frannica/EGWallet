import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

type Theme = 'light' | 'dark';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  colors: typeof lightColors;
}

const lightColors = {
  background: '#FFFFFF',
  card: '#F5F5F5',
  text: '#000000',
  textSecondary: '#666666',
  primary: '#007AFF',
  success: '#34C759',
  error: '#FF3B30',
  warning: '#FF9500',
  border: '#E5E5EA',
  tabBar: '#F2F2F7',
  splash: '#FFFFFF',
};

const darkColors = {
  background: '#000000',
  card: '#1C1C1E',
  text: '#FFFFFF',
  textSecondary: '#98989D',
  primary: '#0A84FF',
  success: '#30D158',
  error: '#FF453A',
  warning: '#FF9F0A',
  border: '#38383A',
  tabBar: '#1C1C1E',
  splash: '#000000',
};

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const THEME_STORAGE_KEY = 'egwallet_theme';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    loadTheme();
  }, []);

  async function loadTheme() {
    try {
      const savedTheme = await AsyncStorage.getItem(THEME_STORAGE_KEY);
      if (savedTheme === 'dark' || savedTheme === 'light') {
        setTheme(savedTheme);
      }
    } catch (e) {
      console.warn('Failed to load theme preference', e);
    }
  }

  async function toggleTheme() {
    try {
      const newTheme = theme === 'light' ? 'dark' : 'light';
      await AsyncStorage.setItem(THEME_STORAGE_KEY, newTheme);
      setTheme(newTheme);
    } catch (e) {
      console.warn('Failed to save theme preference', e);
    }
  }

  const colors = theme === 'light' ? lightColors : darkColors;

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, colors }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within ThemeProvider');
  return context;
}
