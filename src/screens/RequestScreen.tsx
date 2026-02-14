import React from 'react';
import { View, Text, Button } from 'react-native';

export default function RequestScreen() {
  return (
    <View style={{flex:1,alignItems:'center',justifyContent:'center', padding: 16}}>
      <Text style={{fontSize:20,fontWeight:'600', marginBottom: 8}}>Request Money</Text>
      <Text style={{backgroundColor:'#fff3cd', color: '#856404', padding: 8, borderRadius: 4, marginBottom: 16, textAlign: 'center'}}>
        🔄 Beta Feature - Coming Soon
      </Text>
      <Text style={{textAlign: 'center', color: '#666'}}>Request money from contacts (placeholder)</Text>
      <Button title="Create Request" onPress={() => {}} disabled />
    </View>
  );
}
