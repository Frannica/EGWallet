import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { logError } from './sentry';
import { navigationRef } from '../navigation/AppNavigator';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
  resetKey: number;
}

export class GlobalErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, resetKey: 0 };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: any) {
    console.error("GLOBAL CRASH:", error);
    console.error("Component stack:", info.componentStack);
    
    // Send to Sentry (production only)
    logError(error, { componentStack: info.componentStack });
  }

  handleRestart = async () => {
    console.log('🔄 GlobalErrorBoundary: Performing hard reset...');
    
    try {
      // Step 1: Reset navigation state to initial route
      if (navigationRef.isReady()) {
        console.log('🧭 Resetting navigation to Main screen...');
        navigationRef.reset({
          index: 0,
          routes: [{ name: 'Main' as never }],
        });
      }
      
      // Step 2: Increment resetKey to force complete React tree remount
      console.log('🔑 Incrementing reset key for tree remount...');
      this.setState((prevState) => ({ 
        hasError: false, 
        error: undefined,
        resetKey: prevState.resetKey + 1 
      }));
      
      // Step 3: In production, optionally fully reload (commented out - key reset is usually enough)
      // if (!__DEV__) {
      //   console.log('📦 Reloading app bundle...');
      //   await Updates.reloadAsync();
      // }
      
      console.log('✅ Hard reset complete');
    } catch (e) {
      console.error('⚠️ Reset failed, falling back to basic state reset:', e);
      // Fallback: basic state reset without navigation
      this.setState((prevState) => ({ 
        hasError: false, 
        error: undefined,
        resetKey: prevState.resetKey + 1 
      }));
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <ScrollView contentContainerStyle={styles.scrollContent}>
            <Text style={styles.emoji}>⚠️</Text>
            <Text style={styles.title}>Something went wrong</Text>
            <Text style={styles.subtitle}>
              We're fixing it. Please restart the app or contact support if this continues.
            </Text>
            {__DEV__ && this.state.error && (
              <View style={styles.debugContainer}>
                <Text style={styles.debugTitle}>Error Details (Dev Only):</Text>
                <Text style={styles.debugText}>{this.state.error.toString()}</Text>
                {this.state.error.stack && (
                  <Text style={styles.debugText}>{this.state.error.stack.substring(0, 500)}</Text>
                )}
              </View>
            )}
            <TouchableOpacity style={styles.button} onPress={this.handleRestart}>
              <Text style={styles.buttonText}>Restart App</Text>
            </TouchableOpacity>
            <Text style={styles.hint}>
              If this keeps happening, please close and reopen the app
            </Text>
          </ScrollView>
        </View>
      );
    }

    // Use key prop to force complete React tree remount on error recovery
    return (
      <React.Fragment key={this.state.resetKey}>
        {this.props.children}
      </React.Fragment>
    );
  }
}

const styles = StyleSheet.create({
  container: { 
    flex: 1, 
    backgroundColor: '#f5f5f5' 
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: "center", 
    alignItems: "center", 
    padding: 20 
  },
  emoji: {
    fontSize: 64,
    marginBottom: 20
  },
  title: { 
    fontSize: 24, 
    fontWeight: "bold", 
    marginBottom: 12,
    color: "#333"
  },
  subtitle: { 
    textAlign: "center", 
    color: "#666",
    fontSize: 16,
    marginBottom: 24,
    lineHeight: 24
  },
  button: {
    backgroundColor: '#007AFF',
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 8,
    marginBottom: 16
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600'
  },
  hint: {
    fontSize: 12,
    color: '#999',
    textAlign: 'center',
    marginTop: 8
  },
  debugContainer: {
    backgroundColor: '#fff',
    padding: 12,
    borderRadius: 8,
    marginBottom: 20,
    width: '100%'
  },
  debugTitle: {
    fontWeight: 'bold',
    marginBottom: 8,
    color: '#d32f2f'
  },
  debugText: {
    fontSize: 12,
    color: '#666',
    fontFamily: 'monospace'
  }
});
