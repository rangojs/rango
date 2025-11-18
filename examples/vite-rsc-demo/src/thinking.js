
"$layoute.0"= {
        type: 'layout',
        id:"$layoute.0"
        handler: <Layout />,
        parent: null,
        $revalidate[]= { type: 'revalidate' },
        $parallel[]= { type: 'parallel' },
        $middleware[]= { type: 'middleware' },
        $middleware[]= { type: 'middleware' },
        $layout[]= { type: 'layout' },
    },

    "$layout.0.$layout.0": {
        type: 'layout',
        id:"$layout.0.$layout.0",
        component: <Layout />,
        parent: { type: 'layout', id:"$layoute.0" },
        $revalidate[]= { type: 'revalidate' },
    },
    "$layout.0.$layout.1": {
        type: 'layout',
        id:"$layout.0.$layout.1",
        component: <Layout />,
        parent: { type: 'layout', id:"$layoute.0" },
        $revalidate[]= { type: 'revalidate' },
    },

    '$layout.0.$layout.2': {
        type: 'layout',
        id:"$layout.0.$layout.2",
        component: <Layout />,
        parent: { type: 'layout', id: "$layoute.0" }
        
}
    


{
    

    index: {
        type: 'route',
        id: 'index',
        component: <Route />,
        parent: { type: 'layout', id:"$layout.0.$layout.2" },
        $parallel[]= { type: 'parallel' },
    },

    "products.category": {
        type: 'route',
        id: 'products.category',
        component: <Route />,
        parent: { type: 'layout', id:"$layout.0.$layout.2" },
        $parallel[]= { type: 'parallel' },
    },

    "products.detail.view": {
        type: 'route',
        id: 'products.detail.view',
        component: <Route />,
        parent: { type: 'layout', id:"$layout.0.$layout.2" },
        $parallel[] = { type: 'parallel' },
        $revalidate[] = { type: 'revalidate' },
    },
    
    
}

